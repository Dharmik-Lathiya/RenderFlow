import { QUEUE_NAMES } from '@renderflow/common';
import { abortOnFatal, startWorkerProcess } from '@renderflow/observability';
import { loadQueueConfig } from '@renderflow/queue';

/**
 * media-worker: image generation, TTS voiceover and FFmpeg render.
 *
 * Concurrency is deliberately low (2) because rendering is CPU bound. Phase 4
 * registers the PLAN->SCRIPT->IMAGE->VOICE->RENDER stage handlers and the S3
 * checkpoint writes they resume from after a crash - at which point `main`
 * becomes async.
 */

const APP_NAME = 'media-worker';
const QUEUE = QUEUE_NAMES.MEDIA;

function main(): void {
  const queueConfig = loadQueueConfig();

  const worker = startWorkerProcess({
    appName: APP_NAME,
    queue: QUEUE,
    concurrency: queueConfig.presets[QUEUE].concurrency,
    redisUrl: queueConfig.safeRedisUrl,
    base: { stage: 'bootstrap' },
  });

  // FFmpeg children must be killed on SIGTERM or they outlive the worker and
  // leak CPU. Phase 4 registers the real child-process reaper here.
  worker.shutdown.registerDrain('ffmpeg', () => {
    worker.logger.info({ app: APP_NAME }, 'ffmpeg children terminated');
  });

  worker.logger.info({ app: APP_NAME }, 'no job handlers registered yet (Phase 4)');
}

try {
  main();
} catch (error) {
  abortOnFatal(APP_NAME, error);
}
