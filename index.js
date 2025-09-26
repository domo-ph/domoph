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

// Signup redirect routes for mobile app deeplinks
app.get('/signup/:role', (req, res) => {
  const { role } = req.params;
  
  // Validate role parameter
  const validRoles = ['kasambahay', 'amo', 'employer'];
  if (!validRoles.includes(role)) {
    return res.status(400).send('Invalid role. Valid roles are: kasambahay, amo, employer');
  }
  
  // Create the mobile app deeplink
  const deeplink = `domohousehold://signup/${role}`;
  
  // Create HTML page with automatic redirect and fallback
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Redirecting to Domo App</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }
            .container {
                text-align: center;
                max-width: 400px;
                padding: 2rem;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 20px;
                backdrop-filter: blur(10px);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            .logo {
                font-size: 3rem;
                margin-bottom: 1rem;
            }
            h1 {
                margin-bottom: 1rem;
                font-size: 1.5rem;
            }
            .role {
                background: rgba(255, 255, 255, 0.2);
                padding: 0.5rem 1rem;
                border-radius: 20px;
                display: inline-block;
                margin: 1rem 0;
                text-transform: capitalize;
                font-weight: bold;
            }
            .button {
                display: inline-block;
                padding: 12px 24px;
                background: rgba(255, 255, 255, 0.2);
                color: white;
                text-decoration: none;
                border-radius: 25px;
                margin: 1rem 0.5rem;
                transition: all 0.3s ease;
                border: 2px solid rgba(255, 255, 255, 0.3);
            }
            .button:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: translateY(-2px);
            }
            .fallback {
                margin-top: 2rem;
                font-size: 0.9rem;
                opacity: 0.8;
            }
            .spinner {
                border: 3px solid rgba(255, 255, 255, 0.3);
                border-top: 3px solid white;
                border-radius: 50%;
                width: 30px;
                height: 30px;
                animation: spin 1s linear infinite;
                margin: 1rem auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">🏠</div>
            <h1>Welcome to Domo</h1>
            <div class="role">${role} Signup</div>
            <div class="spinner"></div>
            <p>Redirecting to the Domo app...</p>
            
            <div class="fallback">
                <p>If the app doesn't open automatically:</p>
                <a href="${deeplink}" class="button">Open in App</a>
                <a href="https://apps.apple.com/app/domo" class="button">Download iOS</a>
                <a href="https://play.google.com/store/apps/details?id=com.domohousehold" class="button">Download Android</a>
            </div>
        </div>

        <script>
            // Try to redirect to the mobile app
            const deeplink = '${deeplink}';
            
            // Create a hidden iframe to attempt the redirect
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = deeplink;
            document.body.appendChild(iframe);
            
            // Fallback: try window.location after a delay
            setTimeout(() => {
                try {
                    window.location.href = deeplink;
                } catch (e) {
                    console.log('Could not redirect to app');
                }
            }, 1000);
            
            // Remove iframe after attempt
            setTimeout(() => {
                if (iframe.parentNode) {
                    iframe.parentNode.removeChild(iframe);
                }
            }, 2000);
        </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

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

// Serve static files from the root directory
app.use(express.static(path.join(__dirname)));

// Serve the main landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});