/** 软件设置：默认值、归一化、持久化。 */
import { DEFAULT_VIEW_SETTINGS, SETTINGS_STORAGE_KEY, loadViewSettings, normalizeViewSettings, saveViewSettings } from '../src/settings';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ?? ''); }
}

const storage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    dump: () => data,
  };
})();

check('默认设置包含高亮颜色', DEFAULT_VIEW_SETTINGS.highlightColor === '#2563eb');
check('默认设置包含吸附步长', DEFAULT_VIEW_SETTINGS.snapStep === 0.1);
check('默认开启旋转惯性', DEFAULT_VIEW_SETTINGS.rotateDamping === true);
check('默认渲染分辨率 100%', DEFAULT_VIEW_SETTINGS.renderScale === 1);
check('默认界面字号 100%', DEFAULT_VIEW_SETTINGS.uiFontScale === 1);

const defaults = loadViewSettings(storage);
check('空存储返回默认值', JSON.stringify(defaults) === JSON.stringify(DEFAULT_VIEW_SETTINGS), defaults);

const custom = {
  ...DEFAULT_VIEW_SETTINGS,
  highlightColor: '#ff8800',
  backgroundColor: '#101010',
  showGrids: false,
  snapStep: 0.5,
};
saveViewSettings(custom, storage);
check('写入使用固定 key', storage.dump().has(SETTINGS_STORAGE_KEY));
const restored = loadViewSettings(storage);
check('保存/读取往返一致', restored.highlightColor === '#ff8800' && restored.snapStep === 0.5 && restored.showGrids === false, restored);

const normalized = normalizeViewSettings({
  highlightColor: 'red',
  snapStep: 0.3,
  showStats: 'yes',
  unknownKey: 1,
});
check('非法颜色回退默认', normalized.highlightColor === DEFAULT_VIEW_SETTINGS.highlightColor);
check('非法步长回退默认', normalized.snapStep === DEFAULT_VIEW_SETTINGS.snapStep);
check('非布尔值回退默认', normalized.showStats === DEFAULT_VIEW_SETTINGS.showStats);
check('未知字段被忽略', !('unknownKey' in normalized));

const invalidScale = normalizeViewSettings({ renderScale: 0.6 });
check('非法渲染分辨率回退默认', invalidScale.renderScale === DEFAULT_VIEW_SETTINGS.renderScale, invalidScale.renderScale);
const scale = normalizeViewSettings({ renderScale: 0.75, rotateDamping: false });
check('合法渲染分辨率/惯性开关保留', scale.renderScale === 0.75 && scale.rotateDamping === false, scale);

const fontScale = normalizeViewSettings({ uiFontScale: 1.25 });
check('合法界面字号保留', fontScale.uiFontScale === 1.25, fontScale.uiFontScale);
check('非法界面字号回退默认', normalizeViewSettings({ uiFontScale: 1.2 }).uiFontScale === DEFAULT_VIEW_SETTINGS.uiFontScale);
check('180% 字号合法', normalizeViewSettings({ uiFontScale: 1.8 }).uiFontScale === 1.8);

const partial = normalizeViewSettings({ highlightColor: '#00ff00' });
check('部分字段与默认值合并', partial.highlightColor === '#00ff00' && partial.showCoordinates === DEFAULT_VIEW_SETTINGS.showCoordinates);

check('null 输入回退默认', normalizeViewSettings(null).highlightColor === DEFAULT_VIEW_SETTINGS.highlightColor);

storage.setItem(SETTINGS_STORAGE_KEY, '{bad json');
check('坏 JSON 回退默认', loadViewSettings(storage).highlightColor === DEFAULT_VIEW_SETTINGS.highlightColor);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
