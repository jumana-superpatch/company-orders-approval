export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth") return auth(request, env);
    if (url.pathname === "/auth/callback") return callback(request, env);
    if (url.pathname === "/order/decision") return decision(request, env);

    return new Response("Not Found", { status: 404 });
  }
};

/* ======== OAUTH ======== */
function auth(request, env) {
  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) return new Response("Missing shop", { status: 400 });

  const redirect = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${env.SHOPIFY_CLIENT_ID}` +
    `&scope=read_orders,write_orders,write_draft_orders` +
    `&redirect_uri=${encodeURIComponent(env.APP_URL + "/auth/callback")}`;

  return Response.redirect(redirect, 302);
}

function callback(request, env) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");
  if (!shop || !code) return new Response("Invalid callback", { status: 400 });

  return fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      code
    }).toString()
  })
    .then(res => res.json())
    .then(data => {
      if (!data.access_token) return new Response("OAuth failed", { status: 500 });
      return env.SHOPIFY_ACCESS_TOKEN.put(shop, data.access_token)
        .then(() => new Response("App installed successfully"));
    })
    .catch(err => new Response(`OAuth error: ${err.message}`, { status: 500 }));
}

/* ======== ORDER DECISION ======== */
function decision(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  return request.json()
    .then(body => {
      const { shop, draftOrderId, decision } = body;
      if (!shop || !draftOrderId || !decision) return new Response("Missing data", { status: 400 });

      return env.SHOPIFY_ACCESS_TOKEN.get(shop)
        .then(token => {
          if (!token) return new Response("Unauthorized", { status: 401 });

          if (decision === "approve") return completeDraftOrder(shop, draftOrderId, token, env);
          if (decision === "reject") return rejectDraftOrder(shop, draftOrderId, token, env);

          return new Response("Invalid decision", { status: 400 });
        });
    })
    .catch(() => new Response("Invalid JSON body", { status: 400 }));
}

/* ======== DRAFT ORDER ACTIONS ======== */
function completeDraftOrder(shop, draftOrderId, token, env) {
  const body = {
    query: `
      mutation($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id name completedAt order { id name } }
          userErrors { field message }
        }
      }
    `,
    variables: { id: draftOrderId }
  };

  return fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
    .then(res => res.json())
    .then(data => {
      if (data.errors || data.data.draftOrderComplete.userErrors.length) {
        return new Response(JSON.stringify(data), { status: 500 });
      }
      return new Response("Draft order approved and completed");
    })
    .catch(err => new Response(`Error completing order: ${err.message}`, { status: 500 }));
}

function rejectDraftOrder(shop, draftOrderId, token, env) {
  const body = {
    query: `
      mutation($input: DraftOrderInput!) {
        draftOrderUpdate(input: $input) {
          draftOrder { id tags }
          userErrors { field message }
        }
      }
    `,
    variables: { input: { id: draftOrderId, tags: ["rejected"] } }
  };

  return fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
    .then(res => res.json())
    .then(data => {
      if (data.errors || data.data.draftOrderUpdate.userErrors.length) {
        return new Response(JSON.stringify(data), { status: 500 });
      }
      return new Response("Draft order rejected: 'rejected' tag added");
    })
    .catch(err => new Response(`Error rejecting order: ${err.message}`, { status: 500 }));
}
