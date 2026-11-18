/**
 * 按需知识检索：把 docs/AI.md 的配方章节和 shared/models 的模型库变成可检索条目。
 *
 * 为什么不在 SYSTEM_PROMPT 里塞配方：
 * - 提示词是编译期常量，加一条知识就要改代码、重启服务；
 * - 模型一次用不到 49 个章节，全塞进去既烧 token 又稀释注意力。
 * 这里让模型（或请求侧）按关键词**用时才取**，加知识 = 加一份文档/一条别名，不动提示词。
 *
 * 零依赖：中文用 2-gram 字符匹配 + 一张领域别名表打分，不引入向量库。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIBRARY_MODELS, modelDocument, modelParamSpecs, modelHasParams } from '../../shared/library.js';

// 用 cwd 定位，避免 esbuild 打包后 import.meta.url 指向临时目录、读不到 md。
// 服务端从项目根启动（start.bat / npm run server），cwd 就是项目根；测试脚本同样。
const AI_DOC_PATH = resolve(process.cwd(), 'docs', 'AI.md');

/**
 * 领域别名：把用户口语（坦克/履带车）映射到模型 id 和配方标题。
 * 这是唯一需要人工维护的"同义词"数据；加一类新物体就在下面加一行。
 */
const ALIASES = {
  '坦克': { models: ['tank-tracked', 'crawler-crane'], recipes: ['履带与行走机构'] },
  '履带坦克': { models: ['tank-tracked'], recipes: ['履带与行走机构'] },
  '履带': { models: ['tank-tracked', 'crawler-crane'], recipes: ['履带与行走机构'] },
  '履带车': { models: ['tank-tracked', 'crawler-crane'], recipes: ['履带与行走机构'] },
  '履带吊': { models: ['crawler-crane'], recipes: ['履带与行走机构'] },
  '挖掘机': { models: ['crawler-crane'], recipes: ['履带与行走机构'] },
  '起重机': { models: ['crawler-crane'], recipes: ['履带与行走机构'] },
  '吊车': { models: ['crawler-crane'], recipes: ['履带与行走机构'] },
  '轮子': { models: ['crawler-crane', 'gear'], recipes: ['履带与行走机构'] },
  '齿轮': { models: ['gear'], recipes: ['模型库'] },
  '亭子': { models: ['pavilion-hex', 'pavilion-oct'], recipes: ['瓦面', '模型库'] },
  '古建': { models: ['pavilion-hex', 'pavilion-oct'], recipes: ['瓦面', '模型库'] },
  '屋顶': { models: ['pavilion-hex'], recipes: ['瓦面'] },
  '瓦': { models: ['pavilion-hex'], recipes: ['瓦面'] },
  '飞机': { models: ['aircraft-a350'], recipes: ['复杂外形实测', '模型库'] },
  '客机': { models: ['aircraft-a350'], recipes: ['复杂外形实测'] },
  '机翼': { models: ['aircraft-a350'], recipes: ['复杂外形实测'] },
  '无人机': { models: ['quadcopter'], recipes: ['模型库'] },
  '螺旋桨': { models: ['quadcopter'], recipes: ['模型库'] },
  '螺丝刀': { models: ['screwdriver'], recipes: ['模型库'] },
  '花瓶': { models: ['vase'], recipes: ['模型库'] },
  '弯管': { models: ['pipe'], recipes: ['模型库'] },
  '支架': { models: ['bracket'], recipes: ['模型库'] },
};

let recipeCache = null;

/** 把 docs/AI.md 按 ## / ### 标题切成可检索章节（启动后缓存一次） */
export function loadRecipes() {
  if (recipeCache) return recipeCache;
  let text = '';
  try {
    text = readFileSync(AI_DOC_PATH, 'utf8');
  } catch {
    recipeCache = [];
    return recipeCache;
  }
  const lines = text.split(/\r?\n/);
  const recipes = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)$/);
    if (match) {
      current = { level: match[1].length, title: match[2].trim(), body: [] };
      recipes.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  recipeCache = recipes
    .map((item) => ({
      title: item.title,
      level: item.level,
      text: `${item.title}\n${item.body.join('\n').trim()}`,
    }))
    .filter((item) => item.text.length > 80);
  return recipeCache;
}

/**
 * 中文按 2-gram 切分；连续的拉丁字母/数字按**完整词**切分（不切碎）。
 * 否则「qwerty」会被切成 qr/re/ty 去误命中文档里的 repair、type 这类代码名。
 */
function grams(text) {
  const flat = String(text ?? '').toLowerCase();
  const set = new Set();
  // 拉丁词：整体作为一个 token，长度 ≥2 才收（单个字母无区分度）
  for (const word of flat.match(/[a-z][a-z0-9_-]+/g) ?? []) set.add(word);
  // 中文串：去掉标点与拉丁后按 2-gram
  const cjk = flat.replace(/[a-z0-9_\-\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i < cjk.length - 1; i += 1) set.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) set.add(cjk);
  return set;
}

function scoreText(queryGrams, text) {
  const target = grams(text);
  let hits = 0;
  for (const gram of queryGrams) {
    if (target.has(gram)) {
      // 拉丁完整词权重更高（更精确），中文 bigram 常规计
      hits += /[a-z]/.test(gram) ? 1.4 : 1;
    }
  }
  return queryGrams.size ? hits / queryGrams.size : 0;
}

/** 别名命中：用户说"坦克"直接加权到 tank-tracked / crawler-crane 和履带配方 */
function aliasHits(query) {
  const found = [];
  const text = String(query ?? '');
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (text.includes(alias)) found.push({ alias, ...target });
  }
  return found;
}

/**
 * 检索建模知识：返回相关配方片段 + 建议的模型 id。
 * @param {string} query 用户原话
 * @param {{recipeLimit?:number, modelLimit?:number, maxChars?:number}} opts
 */
export function searchKnowledge(query, opts = {}) {
  const recipeLimit = Math.max(0, opts.recipeLimit ?? 2);
  const modelLimit = Math.max(0, opts.modelLimit ?? 3);
  const maxChars = Math.max(200, opts.maxChars ?? 2400);
  const qGrams = grams(query);
  const alias = aliasHits(query);
  const aliasRecipeTitles = new Set(alias.flatMap((item) => item.recipes ?? []));
  const aliasModelIds = alias.flatMap((item) => item.models ?? []);

  const recipes = loadRecipes()
    .map((recipe) => {
      let score = scoreText(qGrams, recipe.title) * 1.6 + scoreText(qGrams, recipe.text.slice(0, 600)) * 0.5;
      if ([...aliasRecipeTitles].some((title) => recipe.title.includes(title))) score += 1.2;
      return { ...recipe, score };
    })
    .filter((item) => item.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, recipeLimit)
    .map((item) => ({ title: item.title, score: Number(item.score.toFixed(2)), text: item.text.slice(0, maxChars) }));

  const models = LIBRARY_MODELS
    .map((entry) => {
      const doc = modelDocument(entry.id);
      let score = scoreText(qGrams, `${entry.name} ${entry.summary}`);
      if (aliasModelIds.includes(entry.id)) score += 1.5;
      return { id: entry.id, name: entry.name, summary: entry.summary, featureCount: entry.featureCount, score };
    })
    .filter((item) => item.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, modelLimit)
    .map((item) => ({
      ...item,
      score: Number(item.score.toFixed(2)),
      params: modelHasParams(item.id) ? modelParamSpecs(item.id).map((spec) => spec.key) : [],
    }));

  return { recipes, models, alias: alias.map((item) => item.alias) };
}

/** 把检索结果渲染成给模型看的一段 system 消息（只读知识的注入格式） */
export function formatKnowledge(query, opts = {}) {
  const found = searchKnowledge(query, opts);
  if (!found.recipes.length && !found.models.length) return '';
  const parts = ['【按需召回的建模知识】以下是根据本次需求检索到的资料，可直接照用或改为已检索到的模型：'];
  for (const recipe of found.recipes) {
    parts.push(`\n--- 配方：${recipe.title} ---\n${recipe.text}`);
  }
  if (found.models.length) {
    parts.push('\n--- 可复用模型（用 addSolid { library: id } 取整棵特征树）---');
    for (const model of found.models) {
      parts.push(`· ${model.id}（${model.name}，${model.featureCount} 个特征）：${model.summary}${model.params.length ? `；参数：${model.params.join('、')}` : ''}`);
    }
  }
  return parts.join('\n');
}
