import { getAuthToken } from '../data/http';

/**
 * 服务端 STEP 转换结果（server/convert/step_to_mesh.py）。
 * 二进制布局：magic(8) + version(uint32) + headerLength(uint32) + header(JSON, 4 字节对齐)
 *            + positions(Float32 × 3V) + colors(Float32 × 3V，线性 RGB)
 */
export interface ServerMeshStats {
  faces: number;
  coloredFaces: number;
  defaultFaces: number;
  solids: number;
  elapsedMs: number;
  bounds?: number[];
}

export interface ServerMesh {
  positions: Float32Array;
  colors: Float32Array;
  vertexCount: number;
  triangleCount: number;
  stats: ServerMeshStats;
}

const MAGIC = 'STRUMESH';

interface MeshHeader {
  version: number;
  vertexCount: number;
  triangleCount: number;
  unitScale: number;
  stats: ServerMeshStats;
}

export function decodeServerMesh(buffer: ArrayBuffer): ServerMesh {
  if (buffer.byteLength < 24) throw new Error('服务端网格数据为空');
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  if (magic !== MAGIC) throw new Error('服务端网格格式无法识别（magic 不匹配）');
  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  if (version !== 1) throw new Error(`不支持的服务端网格版本：${version}`);
  const headerLength = view.getUint32(12, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, headerLength))) as MeshHeader;
  const offset = 16 + headerLength;
  if (offset % 4 !== 0) throw new Error('服务端网格头部未对齐');
  const vertexCount = Number(header.vertexCount);
  const needed = offset + vertexCount * 3 * 4 * 2;
  if (!Number.isFinite(vertexCount) || vertexCount <= 0 || buffer.byteLength < needed) {
    throw new Error('服务端网格数据不完整');
  }
  return {
    positions: new Float32Array(buffer, offset, vertexCount * 3),
    colors: new Float32Array(buffer, offset + vertexCount * 3 * 4, vertexCount * 3),
    vertexCount,
    triangleCount: header.triangleCount ?? Math.floor(vertexCount / 3),
    stats: header.stats,
  };
}

export interface StepConvertProgress {
  phase: 'upload' | 'convert' | 'download';
  loaded: number;
  total: number;
}

/**
 * 上传 STEP 到服务端用 OCCT（XCAF 样式表）解析，并报告上传/转换/下载进度。
 * 转换器不可用（404/501/503）或网络失败时返回 null，调用方回退到浏览器 occt-import-js。
 */
export function fetchServerStepMesh(
  file: File,
  options: { onProgress?: (progress: StepConvertProgress) => void } = {},
): Promise<ServerMesh | null> {
  const { onProgress } = options;
  const token = getAuthToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert/step');
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.({ phase: 'upload', loaded: event.loaded, total: event.total });
      }
    };
    xhr.upload.onload = () => onProgress?.({ phase: 'convert', loaded: 0, total: 0 });
    xhr.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.({ phase: 'download', loaded: event.loaded, total: event.total });
      }
    };
    xhr.onerror = () => resolve(null);
    xhr.onabort = () => resolve(null);
    xhr.onload = () => {
      if (xhr.status === 404 || xhr.status === 501 || xhr.status === 503) {
        resolve(null);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `STEP 转换失败（HTTP ${xhr.status}）`;
        try {
          const data = JSON.parse(new TextDecoder().decode(xhr.response as ArrayBuffer)) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // 保留默认信息
        }
        reject(new Error(message));
        return;
      }
      try {
        resolve(decodeServerMesh(xhr.response as ArrayBuffer));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('服务端网格解析失败'));
      }
    };
    xhr.send(file);
  });
}
