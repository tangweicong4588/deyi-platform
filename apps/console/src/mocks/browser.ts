import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

const worker = setupWorker(...handlers);

/** 仅开发/演示用：启动 MSW 拦截。生产构建不受影响（VITE_USE_MOCK 门控）。 */
export async function startMock(): Promise<void> {
  await worker.start({ onUnhandledRequest: 'bypass' });
  console.info('[MSW] mock 已启用（VITE_USE_MOCK=true）');
}
