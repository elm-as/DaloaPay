// Script de test pour l'API Railway
const https = require('https');

const options = {
  hostname: 'moneypay-production.up.railway.app',
  port: 443,
  path: '/create-payment',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
};

const data = JSON.stringify({
  type: 'seller_badge',
  amount: 1000,
  customerName: 'Test',
  customerPhone: '0123456789',
  userId: '550e8400-e29b-41d4-a716-446655440000'
});

console.log('Testing API...');
console.log('Request:', options);
console.log('Body:', data);

const req = https.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Headers:`, res.headers);

  let body = '';
  res.on('data', (chunk) => {
    body += chunk;
  });

  res.on('end', () => {
    console.log('Response body:', body);
    try {
      const parsed = JSON.parse(body);
      console.log('Parsed:', parsed);
    } catch (e) {
      console.log('Not valid JSON');
    }
  });
});

req.on('error', (e) => {
  console.error(`Error: ${e.message}`);
});

req.write(data);
req.end();
