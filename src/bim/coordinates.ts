import type { Vec2 } from './types';

/**
 * 解析长度输入：`3.6`、`3.6m`、`360cm`、`3600mm` 都合法，统一换算成米。
 * 允许正负号与小数点开头（`.5`），不接受科学计数法以外的杂字符。
 */
export function parseLength(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/[\s,]/g, '');
  if (!text) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(mm|cm|m)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ?? 'm';
  if (unit === 'mm') return value / 1000;
  if (unit === 'cm') return value / 100;
  return value;
}

/** 解析角度输入：`90`、`90°`、`-45度` 都合法，返回度。 */
export function parseAngle(raw: string): number | null {
  const text = raw.trim().replace(/[°度]/g, '');
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 极坐标 → 世界坐标（Z-up 平面）：角度自 +X 轴逆时针，单位为度。 */
export function polarPoint(start: Vec2, length: number, degrees: number): Vec2 {
  const rad = (degrees * Math.PI) / 180;
  // 90° 的余弦是 6e-17：先把噪声归零，轴网坐标才不会被写成 2.000000000000001
  const dx = length * Math.cos(rad);
  const dy = length * Math.sin(rad);
  return [
    start[0] + (Math.abs(dx) < 1e-12 ? 0 : dx),
    start[1] + (Math.abs(dy) < 1e-12 ? 0 : dy),
  ];
}
