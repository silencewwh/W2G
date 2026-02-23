import mqtt from 'mqtt';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function check(url) {
  console.log(`\n=== CONNECT ${url} ===`);

  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const topic = `w2g/_healthcheck/${nonce}`;
  const payload = `ping-${nonce}`;
  const clientId = `w2g-health-${nonce}`;

  const client = mqtt.connect(url, {
    clientId,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 8000,
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 9000);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    console.log(`connected as ${clientId}`);

    await new Promise((resolve, reject) => {
      client.subscribe(topic, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    });
    console.log(`subscribed ${topic}`);

    const loopbackOk = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no loopback message received')), 8000);

      client.on('message', (receivedTopic, message) => {
        if (receivedTopic !== topic) return;
        if (message.toString() !== payload) return;
        clearTimeout(timer);
        resolve(true);
      });

      client.publish(topic, payload, { qos: 0, retain: false }, (err) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    console.log(`loopback ok: ${loopbackOk}`);
  } finally {
    client.end(true);
    await wait(250);
  }
}

try {
  await check('wss://chihuaiyu.asia:9001');
  await check('mqtts://chihuaiyu.asia:8883');
  console.log('\nALL OK');
  process.exit(0);
} catch (err) {
  console.error('\nFAILED:', err?.stack || err);
  process.exit(1);
}
