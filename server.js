import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let isProcessing = false;

app.use(express.json());
app.use(express.static(__dirname));

// Verify password endpoint
app.post('/api/verify-password', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Invalid password' });
  }
});

// Run script endpoint
app.post('/api/run-script', (req, res) => {
  const { password } = req.body;
  
  if (password !== PASSWORD) {
    return res.json({ success: false, message: 'Invalid password' });
  }

  if (isProcessing) {
    return res.json({ success: false, message: 'Script is already running' });
  }

  isProcessing = true;
  
  const scriptProcess = spawn('node', ['index.js'], {
    cwd: __dirname,
    env: process.env
  });

  let output = '';
  let errorOutput = '';

  scriptProcess.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    console.log(text);
  });

  scriptProcess.stderr.on('data', (data) => {
    const text = data.toString();
    errorOutput += text;
    console.error(text);
  });

  scriptProcess.on('close', (code) => {
    isProcessing = false;
    console.log(`Script exited with code ${code}`);
  });

  res.json({ 
    success: true, 
    message: 'Script started successfully',
    pid: scriptProcess.pid
  });
});

// Check if script is running
app.get('/api/status', (req, res) => {
  res.json({ isProcessing });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
