import type { LnwjingApi } from '@lnwjing/ipc-contracts';

declare global {
  interface Window {
    readonly lnwjing: LnwjingApi;
  }
}

export {};
