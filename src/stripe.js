// ============================================================================
// STRIPE BILLING
// Handles Checkout sessions, webhook events, subscription management,
// and customer portal. Plans: Pro ($29/mo, 5 sites), Agency ($59/mo, 25 sites).
// ============================================================================

// Plan configuration — prices are created in Stripe Dashboard
const PLANS = {
  pro: {
    name: 'Pro',
    siteLimit: 5,
    monthlyPrice: 2900, // cents
  },
  agency: {
    name: 'Agency',
    siteLimit: 25,
    monthlyPrice: 5900, // cents
  }
};

export { PLANS };

// ============================================================================
// CHECKOUT SESSION
// ============================================================================

/**
 * Create a Stripe Checkout session for a plan upgrade.
 *
 * @param {string} plan - 'pro' or 'agency'
 * @param {object} user - { userId, email }
 * @param {object} env - Worker env bindings
 * @param {string} baseUrl - e.g. "https://shelobweb.com"
 * @returns {Promise<{ url: string }>} Checkout session URL
 */
export async function createCheckoutSession(plan, user, env, baseUrl) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured');
  }

  if (!PLANS[plan]) {
    throw new Error(`Invalid plan: ${plan}`);
  }

  const priceId = plan === 'pro' ? env.STRIPE_PRO_PRICE_ID : env.STRIPE_AGENCY_PRICE_ID;
  if (!priceId) {
    throw new Error(`Stripe price ID not configured for ${plan} plan`);
  }

  // Check if user already has a Stripe customer ID
  const userRecord = await env.DB.prepare(
    'SELECT stripe_customer_id FROM users WHERE id = ?'
  ).bind(user.userId).first();

  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', `${baseUrl}/dashboard?billing=success`);
  params.append('cancel_url', `${baseUrl}/dashboard?billing=cancelled`);
  params.append('metadata[user_id]', user.userId);
  params.append('subscription_data[metadata][user_id]', user.userId);
  params.append('subscription_data[metadata][plan]', plan);

  if (userRecord?.stripe_customer_id) {
    // Existing customer
    params.append('customer', userRecord.stripe_customer_id);
  } else {
    // New customer — let Stripe create one
    params.append('customer_email', user.email);
  }

  // Allow promo codes
  params.append('allow_promotion_codes', 'true');

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const session = await response.json();

  if (!response.ok) {
    console.error('Stripe checkout error:', JSON.stringify(session));
    throw new Error(session.error?.message || 'Failed to create checkout session');
  }

  return { url: session.url, sessionId: session.id };
}

// ============================================================================
// CUSTOMER PORTAL
// ============================================================================

/**
 * Create a Stripe Customer Portal session for managing billing.
 * Allows users to update payment method, view invoices, cancel subscription.
 *
 * @param {object} user - { userId, email }
 * @param {object} env
 * @param {string} baseUrl
 * @returns {Promise<{ url: string }>}
 */
export async function createPortalSession(user, env, baseUrl) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured');
  }

  const userRecord = await env.DB.prepare(
    'SELECT stripe_customer_id FROM users WHERE id = ?'
  ).bind(user.userId).first();

  if (!userRecord?.stripe_customer_id) {
    throw new Error('No billing account found. Please subscribe to a plan first.');
  }

  const params = new URLSearchParams();
  params.append('customer', userRecord.stripe_customer_id);
  params.append('return_url', `${baseUrl}/dashboard`);

  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const session = await response.json();

  if (!response.ok) {
    console.error('Stripe portal error:', JSON.stringify(session));
    throw new Error(session.error?.message || 'Failed to create portal session');
  }

  return { url: session.url };
}

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

/**
 * Handle incoming Stripe webhook events.
 * Verifies the signature, processes the event, updates D1.
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Stripe not configured', { status: 501 });
  }

  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // Verify webhook signature
  const event = await verifyWebhookSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!event) {
    return new Response('Invalid signature', { status: 400 });
  }

  // Idempotency check — skip if we've already processed this event
  const existing = await env.DB.prepare(
    'SELECT id FROM billing_events WHERE stripe_event_id = ?'
  ).bind(event.id).first();

  if (existing) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Process the event
    await processWebhookEvent(event, env);

    // Log the event
    await env.DB.prepare(
      'INSERT INTO billing_events (stripe_event_id, event_type, user_id, subscription_id, data) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      event.id,
      event.type,
      event.data?.object?.metadata?.user_id || null,
      event.data?.object?.id || event.data?.object?.subscription || null,
      JSON.stringify({ type: event.type, created: event.created })
    ).run();

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Process a verified Stripe webhook event.
 */
async function processWebhookEvent(event, env) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object, env);
      break;

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object, env);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object, env);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object, env);
      break;

    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }
}

/**
 * checkout.session.completed — Link Stripe customer to our user, activate plan.
 */
async function handleCheckoutCompleted(session, env) {
  const userId = session.metadata?.user_id;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!userId || !customerId) {
    console.error('Checkout session missing user_id or customer:', session.id);
    return;
  }

  // Update user with Stripe customer + subscription IDs
  await env.DB.prepare(
    'UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(customerId, subscriptionId, userId).run();

  // The subscription.created/updated webhook will handle setting the plan
  console.log(`Checkout completed for user ${userId}, customer ${customerId}`);
}

/**
 * customer.subscription.created/updated — Update plan status.
 */
async function handleSubscriptionUpdated(subscription, env) {
  const userId = subscription.metadata?.user_id;
  const plan = subscription.metadata?.plan;

  if (!userId) {
    // Try to find user by customer ID
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE stripe_customer_id = ?'
    ).bind(subscription.customer).first();

    if (!user) {
      console.error('Cannot find user for subscription:', subscription.id);
      return;
    }

    await updateSubscriptionState(user.id, subscription, plan || determinePlan(subscription), env);
    return;
  }

  await updateSubscriptionState(userId, subscription, plan || determinePlan(subscription), env);
}

/**
 * Update subscription state in both users and subscriptions tables.
 */
async function updateSubscriptionState(userId, subscription, plan, env) {
  const status = subscription.status; // active, past_due, canceled, trialing, unpaid

  // Map Stripe status to our plan field
  let userPlan = plan || 'pro';
  if (status === 'canceled' || status === 'unpaid') {
    userPlan = 'trial'; // Downgrade on cancellation
  }

  // Update users table
  await env.DB.prepare(
    'UPDATE users SET plan = ?, stripe_subscription_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(userPlan, subscription.id, userId).run();

  // Upsert subscriptions table
  await env.DB.prepare(`
    INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, canceled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      canceled_at = excluded.canceled_at,
      updated_at = datetime('now')
  `).bind(
    subscription.id,
    userId,
    subscription.customer,
    userPlan,
    status,
    subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
    subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    subscription.cancel_at_period_end ? 1 : 0,
    subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null
  ).run();

  console.log(`Subscription ${subscription.id} updated: user=${userId} plan=${userPlan} status=${status}`);
}

/**
 * customer.subscription.deleted — Downgrade user to trial.
 */
async function handleSubscriptionDeleted(subscription, env) {
  // Find user by customer ID
  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE stripe_customer_id = ?'
  ).bind(subscription.customer).first();

  if (!user) {
    console.error('Cannot find user for deleted subscription:', subscription.id);
    return;
  }

  // Downgrade to trial
  await env.DB.prepare(
    'UPDATE users SET plan = \'trial\', stripe_subscription_id = NULL, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(user.id).run();

  // Update subscription record
  await env.DB.prepare(
    'UPDATE subscriptions SET status = \'canceled\', canceled_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(subscription.id).run();

  console.log(`Subscription deleted for user ${user.id}, downgraded to trial`);
}

/**
 * invoice.payment_failed — Mark subscription as past_due.
 */
async function handlePaymentFailed(invoice, env) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE stripe_subscription_id = ?'
  ).bind(subscriptionId).first();

  if (user) {
    console.log(`Payment failed for user ${user.id}, subscription ${subscriptionId}`);
    // The subscription.updated webhook will handle the status change to past_due
  }
}

/**
 * Determine plan from subscription price amount.
 */
function determinePlan(subscription) {
  const item = subscription.items?.data?.[0];
  if (!item) return 'pro';

  const amount = item.price?.unit_amount;
  if (amount >= 4900) return 'agency';
  return 'pro';
}

// ============================================================================
// WEBHOOK SIGNATURE VERIFICATION
// ============================================================================

/**
 * Verify Stripe webhook signature using Web Crypto API.
 * Stripe uses HMAC-SHA256 with a tolerance window.
 *
 * @param {string} payload - raw request body
 * @param {string} sigHeader - stripe-signature header
 * @param {string} secret - webhook signing secret (whsec_xxx)
 * @returns {Promise<object|null>} parsed event or null if invalid
 */
async function verifyWebhookSignature(payload, sigHeader, secret) {
  const TOLERANCE_SECONDS = 300; // 5 minutes

  // Parse the signature header
  const elements = sigHeader.split(',');
  let timestamp = null;
  let signatures = [];

  for (const element of elements) {
    const [key, value] = element.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) {
    console.error('Invalid stripe-signature format');
    return null;
  }

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > TOLERANCE_SECONDS) {
    console.error('Stripe webhook timestamp too old');
    return null;
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );

  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  const isValid = signatures.some(sig => timingSafeEqual(sig, expectedSignature));

  if (!isValid) {
    console.error('Stripe webhook signature mismatch');
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch (e) {
    console.error('Failed to parse webhook payload');
    return null;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================================
// BILLING STATUS HELPERS
// ============================================================================

/**
 * Get the current billing status for a user.
 * Returns plan, subscription state, and whether trial has expired.
 *
 * @param {object} userRecord - from users table
 * @returns {object} billing status
 */
export function getBillingStatus(userRecord) {
  const now = new Date();
  const plan = userRecord.plan || 'trial';

  const isTrialExpired = plan === 'trial' && userRecord.trial_ends_at
    && new Date(userRecord.trial_ends_at) < now;

  const trialDaysRemaining = plan === 'trial' && userRecord.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(userRecord.trial_ends_at) - now) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    plan,
    isTrialExpired,
    trialDaysRemaining,
    hasActiveSubscription: ['pro', 'agency'].includes(plan),
    stripeCustomerId: userRecord.stripe_customer_id || null,
    stripeSubscriptionId: userRecord.stripe_subscription_id || null,
    siteLimit: PLANS[plan]?.siteLimit || 5
  };
}
