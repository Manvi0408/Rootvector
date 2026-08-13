// DEV-ONLY embedded Postgres (PGlite) on port 5433 for local verification when
// Docker isn't available. Production uses the real Postgres from docker-compose.
// Reuses the QueryQueueManager hotfix from the parent project's pg-server.js.
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

async function run() {
  const db = await PGlite.create({ dataDir: './.pgdata-dev' });
  const server = new PGLiteSocketServer({
    db, port: 5433, host: '127.0.0.1', maxConnections: 100, inspect: false,
  });

  const proto = server.queryQueue.constructor.prototype;
  proto.processQueue = async function () {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        let query;
        if (this.db.isInTransaction() && this.lastHandlerId) {
          const i = this.queue.findIndex((q) => q.handlerId === this.lastHandlerId);
          query = i === -1 ? null : this.queue.splice(i, 1)[0];
        } else {
          query = this.queue.shift();
        }
        if (!query) break;
        try {
          await this.db.runExclusive(async () =>
            this.db.execProtocolRawStream(query.message, {
              onRawData: (data) => query.onData(data),
            }),
          );
        } catch (error) {
          query.reject(error);
          continue;
        }
        this.lastHandlerId = query.handlerId;
        query.resolve(0);
      }
    } finally {
      this.processing = false;
    }
  };

  await server.start();
  console.log('RootVector dev Postgres (PGlite) on 127.0.0.1:5433');
}
run().catch((e) => { console.error(e); process.exit(1); });
