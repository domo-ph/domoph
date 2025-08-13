const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// Custom middleware to set correct content type for apple-app-site-association
app.get('/.well-known/apple-app-site-association', (req, res) => {
  const filePath = path.join(__dirname, '.well-known', 'apple-app-site-association');
  
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(content);
  } else {
    res.status(404).send('Apple app site association file not found');
  }
});

// Serve other .well-known files with default handling
app.use('/.well-known', express.static(path.join(__dirname, '.well-known')));

// Serve markdown files directly
app.get('/:filename.md', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, `${filename}.md`);
  
  // Check if file exists
  if (fs.existsSync(filePath)) {
    // Read and send the markdown file
    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/markdown');
    res.send(content);
  } else {
    res.status(404).send('Markdown file not found');
  }
});

// Alternative: Serve markdown files from a specific directory
app.get('/markdown/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'markdown', `${filename}.md`);
  
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/markdown');
    res.send(content);
  } else {
    res.status(404).send('Markdown file not found');
  }
});

// Serve static files (including markdown) from a public directory
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});