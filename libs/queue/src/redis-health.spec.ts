jest.mock('ioredis');

import Redis from 'ioredis';

import { createRedisPingProbe } from './redis-health';

interface FakeRedisClient {
  status: string;
  connect: jest.Mock<Promise<void>, []>;
  ping: jest.Mock<Promise<string>, []>;
  quit: jest.Mock<Promise<string>, []>;
  disconnect: jest.Mock<void, []>;
  on: jest.Mock<FakeRedisClient, [string, () => void]>;
}

const RedisConstructor = Redis as unknown as jest.Mock;

describe('createRedisPingProbe', () => {
  let client: FakeRedisClient;

  beforeEach(() => {
    client = {
      status: 'wait',
      connect: jest.fn(async () => {
        client.status = 'ready';
      }),
      ping: jest.fn(async () => 'PONG'),
      quit: jest.fn(async () => 'OK'),
      disconnect: jest.fn(),
      on: jest.fn<FakeRedisClient, [string, () => void]>(() => client),
    };
    RedisConstructor.mockImplementation(() => client);
  });

  it('connects lazily and reports a real PONG', async () => {
    const probe = createRedisPingProbe({
      redisUrl: 'redis://cache:6380/2',
      connectTimeoutMs: 2_000,
    });

    expect(RedisConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'cache',
        port: 6380,
        db: 2,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
      }),
    );
    expect(client.connect).not.toHaveBeenCalled();

    await expect(probe.ping()).resolves.toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect an already-ready client', async () => {
    client.status = 'ready';
    const probe = createRedisPingProbe({
      redisUrl: 'redis://cache:6379',
      connectTimeoutMs: 2_000,
    });

    await expect(probe.ping()).resolves.toBe(true);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('reports anything other than PONG as unhealthy', async () => {
    const probe = createRedisPingProbe({
      redisUrl: 'redis://cache:6379',
      connectTimeoutMs: 2_000,
    });
    client.ping.mockResolvedValue('LOADING');

    await expect(probe.ping()).resolves.toBe(false);
  });

  it('closes a ready client gracefully', async () => {
    client.status = 'ready';
    const probe = createRedisPingProbe({
      redisUrl: 'redis://cache:6379',
      connectTimeoutMs: 2_000,
    });

    await probe.close();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('drops a lazy client without dialling it', async () => {
    const probe = createRedisPingProbe({
      redisUrl: 'redis://cache:6379',
      connectTimeoutMs: 2_000,
    });

    await probe.close();

    expect(client.quit).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
