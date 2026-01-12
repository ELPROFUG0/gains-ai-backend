# Gains AI Backend

Backend API para proteger las API keys de Claude y Perplexity.

## Instalación Local

```bash
cd backend
npm install
npm start
```

El servidor correrá en `http://localhost:3000`

## Despliegue en Render (Gratis)

1. Crea una cuenta en [Render.com](https://render.com)
2. Click en "New +" → "Web Service"
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click "Create Web Service"
6. Copia la URL que te da (ej: `https://gains-ai-backend.onrender.com`)

## Despliegue en Railway (Gratis)

1. Crea una cuenta en [Railway.app](https://railway.app)
2. Click en "New Project" → "Deploy from GitHub repo"
3. Selecciona tu repositorio
4. Railway detectará automáticamente que es Node.js
5. Copia la URL que te da

## Despliegue en Vercel

```bash
npm install -g vercel
cd backend
vercel
```

Sigue las instrucciones y copia la URL.

## Endpoints

### POST /api/claude
Analiza imágenes de alimentos con Claude.

**Body:**
```json
{
  "image": "base64_string",
  "prompt": "texto",
  "systemPrompt": "texto"
}
```

### POST /api/perplexity
Chat de texto con Perplexity.

**Body:**
```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ]
}
```

## Actualizar la App

Después de desplegar, actualiza `ClaudeService.swift` con la URL de tu backend:

```swift
private let backendURL = "https://tu-backend-url.com"
```
