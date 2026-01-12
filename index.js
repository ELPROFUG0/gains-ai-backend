const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Inicializar Firebase Admin (usa credenciales de ambiente en Vercel)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
      })
    });
  } catch (error) {
    console.log('Firebase Admin not initialized (missing credentials)');
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// API Keys (desde variables de entorno)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';

// Endpoint para Claude (análisis de imágenes)
app.post('/api/claude', async (req, res) => {
  try {
    const { image, prompt, systemPrompt } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: image
                }
              },
              {
                type: 'text',
                text: prompt
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(response.status).json({ error: data });
    }

    res.json({ content: data.content[0]?.text || 'No response' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para Perplexity (chat de texto)
app.post('/api/perplexity', async (req, res) => {
  try {
    const { messages } = req.body;

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Perplexity API error:', data);
      return res.status(response.status).json({ error: data });
    }

    const messageContent = data.choices[0]?.message?.content || 'No response';
    const citations = data.citations || [];

    let fullResponse = messageContent;
    if (citations.length > 0) {
      fullResponse += '\n\n---SOURCES---\n';
      citations.forEach(citation => {
        fullResponse += `${citation}\n`;
      });
      fullResponse += '---END_SOURCES---';
    }

    res.json({ content: fullResponse });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// REVENUECAT WEBHOOK - Tracking de compras
// ============================================
app.post('/api/revenuecat-webhook', async (req, res) => {
  try {
    console.log('🔔 Webhook endpoint hit!');

    // Verificar autenticación del webhook (opcional - solo si configuraste secret en RevenueCat)
    const authHeader = req.headers['authorization'];
    if (REVENUECAT_WEBHOOK_SECRET && authHeader !== `Bearer ${REVENUECAT_WEBHOOK_SECRET}`) {
      console.log('Webhook auth failed - expected:', REVENUECAT_WEBHOOK_SECRET ? 'Bearer ***' : 'none');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body;
    console.log('RevenueCat webhook received:', event.event?.type);
    console.log('Full event data:', JSON.stringify(event, null, 2));

    // Solo procesar eventos de compra inicial o renovación
    const purchaseEvents = [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'PRODUCT_CHANGE',
      'NON_RENEWING_PURCHASE'
    ];

    if (!purchaseEvents.includes(event.event?.type)) {
      console.log('Event type not in purchase events, skipping');
      return res.json({ received: true, processed: false });
    }

    // Extraer datos del evento - buscar en múltiples ubicaciones
    const subscriberAttributes = event.event?.subscriber_attributes || {};
    console.log('Subscriber attributes:', JSON.stringify(subscriberAttributes, null, 2));

    // Buscar el código en diferentes formatos posibles
    // También buscar en $campaign que es donde se guarda el código
    const influencerCode = subscriberAttributes['influencer_code']?.value ||
                          subscriberAttributes['referral_code']?.value ||
                          subscriberAttributes['$campaign']?.value ||
                          event.event?.attributes?.['influencer_code']?.value ||
                          event.event?.attributes?.['referral_code']?.value ||
                          event.event?.attributes?.['$campaign']?.value || '';

    console.log('Extracted influencer code:', influencerCode);

    const price = event.event?.price || 0;
    const productId = event.event?.product_id || '';
    const appUserId = event.event?.app_user_id || '';

    console.log(`Purchase: ${productId} - $${price} - Code: ${influencerCode}`);

    // Si hay código de influencer y tenemos Firebase, actualizar stats
    if (influencerCode && db) {
      const codeRef = db.collection('influencer_codes').doc(influencerCode.toUpperCase());

      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(codeRef);

        if (!doc.exists) {
          // Crear el código si no existe
          transaction.set(codeRef, {
            code: influencerCode.toUpperCase(),
            total_signups: 0,
            total_purchases: 1,
            total_revenue: price,
            commission_rate: 0.20,
            created_at: admin.firestore.Timestamp.now(),
            last_purchase_at: admin.firestore.Timestamp.now()
          });
        } else {
          // Actualizar estadísticas
          const data = doc.data();
          transaction.update(codeRef, {
            total_purchases: (data.total_purchases || 0) + 1,
            total_revenue: (data.total_revenue || 0) + price,
            last_purchase_at: admin.firestore.Timestamp.now()
          });
        }

        // Guardar detalle de la compra
        const purchaseRef = codeRef.collection('purchases').doc();
        transaction.set(purchaseRef, {
          user_id: appUserId,
          product_id: productId,
          amount: price,
          commission: price * 0.20, // 20% comisión
          event_type: event.event?.type,
          created_at: admin.firestore.Timestamp.now()
        });
      });

      console.log(`✅ Influencer purchase tracked: ${influencerCode} - $${price}`);
    }

    res.json({ received: true, processed: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INFLUENCER DASHBOARD API
// ============================================

// Obtener estadísticas de un código de influencer
app.get('/api/influencer/:code', async (req, res) => {
  try {
    const { code } = req.params;

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const codeDoc = await db.collection('influencer_codes').doc(code.toUpperCase()).get();

    if (!codeDoc.exists) {
      return res.status(404).json({ error: 'Code not found' });
    }

    const data = codeDoc.data();
    const commissionRate = data.commission_rate || 0.20;

    res.json({
      code: data.code,
      total_signups: data.total_signups || 0,
      total_purchases: data.total_purchases || 0,
      total_revenue: data.total_revenue || 0,
      total_commission: (data.total_revenue || 0) * commissionRate,
      commission_rate: commissionRate,
      created_at: data.created_at?.toDate(),
      last_used_at: data.last_used_at?.toDate(),
      last_purchase_at: data.last_purchase_at?.toDate()
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener historial de compras de un código
app.get('/api/influencer/:code/purchases', async (req, res) => {
  try {
    const { code } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const purchasesSnapshot = await db
      .collection('influencer_codes')
      .doc(code.toUpperCase())
      .collection('purchases')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();

    const purchases = purchasesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      created_at: doc.data().created_at?.toDate()
    }));

    res.json({ purchases });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Crear nuevo código de influencer (solo admin)
app.post('/api/influencer/create', async (req, res) => {
  try {
    const { code, adminKey, commissionRate } = req.body;

    // Verificar admin key
    const ADMIN_KEY = process.env.ADMIN_KEY || 'gainsai2024admin';
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!code || code.length < 3) {
      return res.status(400).json({ error: 'Code must be at least 3 characters' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const codeUppercased = code.toUpperCase();
    const codeRef = db.collection('influencer_codes').doc(codeUppercased);

    // Verificar si ya existe
    const existing = await codeRef.get();
    if (existing.exists) {
      return res.status(400).json({ error: 'Code already exists' });
    }

    // Crear el código
    await codeRef.set({
      code: codeUppercased,
      total_signups: 0,
      total_purchases: 0,
      total_revenue: 0,
      commission_rate: commissionRate || 0.20,
      created_at: admin.firestore.Timestamp.now(),
      last_used_at: null,
      last_purchase_at: null
    });

    res.json({ success: true, code: codeUppercased });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Gains AI Backend API' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
