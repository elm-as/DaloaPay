# 💳 DaloaPay — API Microservice de Paiement Express.js

> **Microservice de traitement des paiements Mobile Money** pour l'écosystème **DM&DD** (DaloaMarket + DaloaDelivery).  
> Repo GitHub : [`elm-as/DaloaPay`](https://github.com/elm-as/DaloaPay)

---

## 📖 Description

DaloaPay est un microservice Node.js / Express.js déployé sur **Railway**. Il gère la communication sécurisée entre la marketplace, les webhooks du prestataire Mobile Money (**Money Fusion**) et la base de données **Supabase** via la clé `service_role`.

### Rôles principaux :
- **Paiements sécurisés** : Initialisation des paiements Mobile Money (Orange Money, MTN MoMo, Wave, Moov).
- **Escrow / Séquestre** : Gestion du cycle de séquestre (fonds bloqués jusqu'à confirmation de livraison).
- **Webhooks & Idempotence** : Réception des notifications instantanées de paiement.
- **Auto-release & Payouts** : Déclenchement automatique des versements aux vendeurs et livreurs.

---

## 🚀 Déploiement Railway

### 1. Variables d'environnement (Railway Dashboard)

Dans Railway Dashboard → **Variables** :

```env
PORT=3000
FUSION_API_URL=
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
SITE_URL=
```

### 2. Endpoints API

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| `GET` | `/` | Health check et statut du service |
| `POST` | `/create-payment` | Initie un paiement Mobile Money pour une commande ou option |
| `GET` | `/check-payment?transactionId=xxx` | Vérifie l'état d'un paiement en direct |
| `POST` | `/payment-webhook` | Webhook de callback appelé par Money Fusion |

---

## 📄 Licence & Propriété Intellectuelle

**Projet propriétaire d'ElmasCore (Elmas) — Tous droits réservés © 2025-2026.**

Ce code source et sa documentation sont la propriété exclusive d'**ElmasCore**. Toute copie, reproduction, distribution ou réutilisation partielle ou totale est strictement interdite sans autorisation écrite préalable. Veuillez consulter le fichier [LICENSE](./LICENSE) pour les termes complets.
