// What `three` means in the WebGPU edition (vite.config.ts, mode 'gpu'; see backend.ts): the WebGPU
// build of the library, plus the few WebGL-only helpers it leaves out that three's add-ons import
// at load time (the WebGL post-processing passes, never constructed in this edition). The classic
// WebGLRenderer doesn't exist here: making one is a mistake (go through createRenderer).
export * from 'three/webgpu';
export { ShaderChunk } from 'three/src/renderers/shaders/ShaderChunk.js';
export { ShaderLib } from 'three/src/renderers/shaders/ShaderLib.js';
export { UniformsLib } from 'three/src/renderers/shaders/UniformsLib.js';
export { UniformsUtils } from 'three/src/renderers/shaders/UniformsUtils.js';
export { WebGLUtils } from 'three/src/renderers/webgl/WebGLUtils.js';
export * as TextureUtils from 'three/src/extras/TextureUtils.js';

export class WebGLRenderer {
  constructor() {
    throw new Error('The WebGPU edition has no WebGLRenderer: make renderers with createRenderer (engine/render/backend.ts).');
  }
}
