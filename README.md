# API Paiement DaloaMarket - Railway

## Déploiement

### 1. Créer le projet Railway

```bash
cd railway-server
npx railway login
npx railway init
npx railway up
```

### 2. Variables d'environnement (Railway Dashboard)

Dans Railway Dashboard → Variables :

```
FUSION_API_URL=https://pay.moneyfusion.net/DaloaMarket/3ac2127f34e0ec8c/pay/
SUPABASE_URL=ta_url_supabase
SUPABASE_SERVICE_ROLE_KEY=ta_cle_service_role
SITE_URL=https://daloamarket.shop
```

### 3. Récupérer l'IP de Railway

Une fois déployé, récupère l'IP sortante de Railway :

```bash
# Dans Railway Logs ou via un test
curl https://ton-url-railway.up.railway.app/
```

Ou demande à Railway l'IP fixe (parfois indiquée dans les docs ou via support).

**Alternative pour connaître l'IP :**
Crée temporairement un endpoint de test :
```javascript
app.get('/ip', async (req, res) => {
  const ip = await fetch('https://api.ipify.org?format=json').then(r => r.json());
  res.json(ip);
});
```

### 4. Configurer Money Fusion

Dans ton dashboard Money Fusion :

- **URL de redirection** : `https://daloamarket.shop/payment/succes`
- **Adresse IP autorisée** : L'IP de Railway (pas ton IP perso !)

### 5. Configurer le Frontend

Dans `.env` de ton projet (et dans Netlify Environment Variables) :

```
VITE_PAYMENT_API_URL=https://ton-url-railway.up.railway.app
```

## Endpoints API

- `POST /create-payment` - Crée un paiement
- `GET /check-payment?transactionId=xxx` - Vérifie le statut
- `POST /payment-webhook` - Webhook appelé par Money Fusion

## Webhook URL à donner à Money Fusion

`https://ton-url-railway.up.railway.app/payment-webhook`
