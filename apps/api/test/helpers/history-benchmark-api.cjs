const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/bootstrap');

async function main() {
  const app = configureApp(
    await NestFactory.create(AppModule, { bufferLogs: true }),
  );
  await app.listen(0, '127.0.0.1');
  let peakHeap = 0;
  const sample = () => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  };
  const sampler = setInterval(sample, 5);
  process.on('message', (command) => {
    if (command === 'baseline') {
      global.gc();
      peakHeap = 0;
    }
    sample();
    process.send({
      peakHeap,
      rss: process.memoryUsage.rss(),
      peakRss: process.resourceUsage().maxRSS * 1024,
    });
  });
  process.on('disconnect', () => {
    clearInterval(sampler);
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
  process.send({ port: app.getHttpServer().address().port });
}
void main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
