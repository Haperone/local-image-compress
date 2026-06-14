declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "imagequant/imagequant_bg.js" {
  export class Imagequant {
    set_quality(min: number, max: number): void;
    set_speed(speed: number): void;
    process(image: ImagequantImage): Uint8Array;
    free(): void;
  }
  export class ImagequantImage {
    constructor(data: Uint8Array, width: number, height: number, gamma: number);
    free(): void;
  }
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
  export function __wbindgen_error_new(ptr: number, len: number): unknown;
  export function __wbindgen_throw(ptr: number, len: number): never;
}

declare module "@jsquash/jpeg/decode.js" {
  export function init(module: WebAssembly.Module, moduleOptionOverrides?: Record<string, unknown>): Promise<void>;
  export default function decode(buffer: ArrayBuffer, options?: Record<string, unknown>): Promise<ImageData>;
}

declare module "@jsquash/jpeg/encode.js" {
  export function init(module: WebAssembly.Module, moduleOptionOverrides?: Record<string, unknown>): Promise<void>;
  export default function encode(data: ImageData, options?: Record<string, unknown>): Promise<ArrayBuffer>;
}

declare module "virtual:compression-worker" {
  const source: string;
  export default source;
}
