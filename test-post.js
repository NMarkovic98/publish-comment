const { postReplyToReddit } = require('./src/reddit-poster');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

// Promeni ovo pre testiranja:
const REDDIT_URL = process.argv[2] || 'https://www.reddit.com/r/test12331/comments/1sc8qw4/testt/';
const IMAGE_PATH = process.argv[3] || path.join(__dirname, 'tmp', '70c43d6662be192b1af63b7ccfb7ca23.jpg');
const PAYPAL_LINK = process.argv[4] || process.env.PAYPAL_LINK || '';

(async () => {
  console.log('Testing postReplyToReddit...');
  console.log('  URL:', REDDIT_URL);
  console.log('  Image:', IMAGE_PATH);
  const result = await postReplyToReddit({ redditUrl: REDDIT_URL, imagePath: IMAGE_PATH, paypalLink: PAYPAL_LINK });
  console.log('Result:', result);
  process.exit(result.success ? 0 : 1);
})();
