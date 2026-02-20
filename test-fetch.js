
const endpoint = 'https://ark-cn-beijing.bytedance.net/api/v3/responses';

try {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test'
    },
    body: JSON.stringify({ model: 'test', input: [], stream: false })
  });
  console.log('Status:', resp.status);
  const data = await resp.json();
  console.log('Data:', data);
} catch (e) {
  console.error('Error:', e);
}
