import importerScriptUrl from 'occt-import-js/dist/occt-import-js.js?url';
import importerWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

export interface StepMesh {
  name: string;
  color?: number[];
  brep_faces?: Array<{
    first: number;
    last: number;
    color: number[] | null;
  }>;
  attributes?: {
    position?: { array: number[] };
  };
  index?: { array: number[] };
}

interface StepImportResult {
  success: boolean;
  meshes: StepMesh[];
}

interface OcctImportApi {
  ReadStepFile: (
    content: Uint8Array,
    params: {
      linearUnit: 'meter';
      linearDeflectionType: 'bounding_box_ratio';
      linearDeflection: number;
      angularDeflection: number;
    },
  ) => StepImportResult;
}

type OcctImporterFactory = (options: { locateFile: () => string }) => Promise<OcctImportApi>;

declare global {
  interface Window {
    occtimportjs?: OcctImporterFactory;
  }
}

let importerPromise: Promise<OcctImportApi> | undefined;

export function loadStepImporter(): Promise<OcctImportApi> {
  if (!importerPromise) {
    importerPromise = new Promise<OcctImportApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = importerScriptUrl;
      script.async = true;
      script.onload = () => {
        const factory = window.occtimportjs;
        if (!factory) {
          reject(new Error('STEP 几何内核加载失败。'));
          return;
        }
        void factory({ locateFile: () => importerWasmUrl }).then(resolve, reject);
      };
      script.onerror = () => reject(new Error('STEP 导入模块加载失败，请检查网络或重新加载页面。'));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      importerPromise = undefined;
      throw error;
    });
  }
  return importerPromise;
}
