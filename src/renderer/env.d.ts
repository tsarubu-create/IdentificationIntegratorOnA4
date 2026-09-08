/// <reference types="vite/client" />

import type { RendererApi } from '@shared/ipc';

declare global {
  interface Window {
    /** preload が公開する API。これ以外の経路で main と通信しない。 */
    readonly api: RendererApi;
  }
}

export {};
