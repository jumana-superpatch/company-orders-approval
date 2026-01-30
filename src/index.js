export default {
  fetch(req, env) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/auth") return auth(searchParams, env);
    if (pathname === "/auth/callback") return callback(searchParams, env);
    if (pathname === "/order/decision") return decision(searchParams, env);
    return new Response("Not Found", { status: 404 });
  }
};

const html = (body) => new Response(body, { headers: { "Content-Type": "text/html" } });

/* ======== OAUTH ======== */
function auth(params, env) {
  const shop = params.get("shop");
  if (!shop) return new Response("Missing shop", { status: 400 });

  const redirect = `https://${shop}/admin/oauth/authorize?client_id=${env.SHOPIFY_CLIENT_ID}&scope=read_orders,write_orders,write_draft_orders&redirect_uri=${encodeURIComponent(env.APP_URL + "/auth/callback")}`;
  return Response.redirect(redirect, 302);
}

function callback(params, env) {
  const shop = params.get("shop"), code = params.get("code");
  if (!shop || !code) return new Response("Invalid callback", { status: 400 });

  return fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code })
  })
    .then(res => res.json())
    .then(data => data.access_token ? env.SHOPIFY_ACCESS_TOKEN.put(shop, data.access_token) : Promise.reject(new Error("No token")))
    .then(() => new Response("App installed"))
    .catch(err => new Response(err.message, { status: 500 }));
}

/* ======== ORDER DECISION ======== */
function decision(params, env) {
  const shop = params.get("shop"), id = params.get("draftOrderId"), action = params.get("decision");
  if (!shop || !id || !action) return new Response("Missing params", { status: 400 });

  return env.SHOPIFY_ACCESS_TOKEN.get(shop).then(token => {
    if (!token) return new Response("Unauthorized", { status: 401 });
    return action === "approve" ? completeOrder(shop, id, token, env) : rejectOrder(shop, id, token, env);
  });
}

/* ======== HELPERS & ACTIONS ======== */
function gql(shop, token, env, query, variables) {
  return fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  }).then(res => res.json());
}

async function completeOrder(shop, id, token, env) {
  return gql(shop, token, env, `mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { completedAt order { name } } userErrors { message } } }`, { id })
    .then(res => {
      const result = res.data?.draftOrderComplete;
      return result?.draftOrder?.completedAt 
        ? html(`<h2>Approved</h2><p>Order ${result.draftOrder.order.name} created.</p>`)
        : html(`<h2>Error</h2><p>${result?.userErrors?.[0]?.message || "Failed"}</p>`);
    })
    .catch(err => new Response(err.message, { status: 500 }));
}

async function rejectOrder(shop, id, token, env) {
  return gql(shop, token, env, `query($id: ID!) { draftOrder(id: $id) { status } }`, { id })
    .then(res => {
      if (res.data?.draftOrder?.status === "COMPLETED") {
        return html(`<h2>Cannot Reject</h2><p>This order has already been approved and completed.</p>`);
      }
      return gql(shop, token, env, `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { userErrors { message } } }`, { id, input: { tags: ["rejected"] } })
        .then(res => res.data?.draftOrderUpdate?.userErrors?.length 
          ? new Response("Update failed", { status: 400 }) 
          : html(`<h2>Rejected</h2><p>Order tagged as rejected.</p>`));
    })
    .catch(err => new Response(err.message, { status: 500 }));
}
