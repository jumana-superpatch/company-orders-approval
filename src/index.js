/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// export default {
// 	async fetch(request, env, ctx) {
// 		return new Response('Hello World!');
// 	},
// };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      return auth(request, env);
    }

    if (url.pathname === "/auth/callback") {
      return callback(request, env);
    }

    if (url.pathname === "/order/decision") {
      return decision(request, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* ================= OAUTH ================= */

function auth(request, env) {
  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) return new Response("Missing shop", { status: 400 });

  const redirect =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${env.SHOPIFY_CLIENT_ID}` +
    `&scope=read_orders,write_orders` +
    `&redirect_uri=${encodeURIComponent(env.APP_URL + "/auth/callback")}`;

  return Response.redirect(redirect, 302);
}

async function callback(request, env) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");

  if (!shop || !code) {
    return new Response("Invalid callback", { status: 400 });
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      code
    })
  });

  const { access_token } = await res.json();

  if (!access_token) {
    return new Response("OAuth failed", { status: 500 });
  }

  await env.TOKENS.put(shop, access_token);

  return new Response("App installed");
}

/* ================= ORDER DECISION ================= */

async function decision(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { shop, order_id, decision } = await request.json();

  if (!shop || !order_id || !decision) {
    return new Response("Missing data", { status: 400 });
  }

  const token = await env.TOKENS.get(shop);
  if (!token) return new Response("Unauthorized", { status: 401 });

  if (decision === "reject") {
    return cancelOrder(shop, order_id, token, env);
  }

  if (decision === "approve") {
    return approveOrder(shop, order_id, token, env);
  }

  return new Response("Invalid decision", { status: 400 });
}

/* ================= SHOPIFY ACTIONS ================= */

async function cancelOrder(shop, orderId, token, env) {
  const res = await fetch(
    `https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/orders/${orderId}/cancel.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      }
    }
  );

  return res.ok
    ? new Response("Order rejected")
    : new Response("Cancel failed", { status: 500 });
}

async function approveOrder(shop, orderId, token, env) {
  const res = await fetch(
    `https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/orders/${orderId}/transactions.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transaction: { kind: "capture" }
      })
    }
  );

  return res.ok
    ? new Response("Order approved")
    : new Response("Approval failed", { status: 500 });
}
