export default {
  fetch(req, env) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/auth") return auth(searchParams, env);
    if (pathname === "/auth/callback") return callback(searchParams, env);
    if (pathname === "/order/decision") return decision(searchParams, env);
    return new Response("Not Found", { status: 404 });
  }
};

/* Modern UI Wrapper */
const html = (title, content, isAutoClose = true) => new Response(`
  <!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 90%; }
        h2 { color: #202223; margin-top: 0; font-size: 1.25rem; }
        p { color: #6d7175; line-height: 1.5; margin-bottom: 1.5rem; }
        .btn { border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: 600; font-size: 14px; text-decoration: none; display: inline-block; transition: background 0.2s; }
        .btn-primary { background: #008060; color: white; margin-right: 10px; }
        .btn-primary:hover { background: #006e52; }
        .btn-secondary { background: #f6f6f7; color: #202223; border: 1px solid #bdc1c4; }
        .btn-secondary:hover { background: #edeeef; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>${title}</h2>
        <div>${content}</div>
      </div>
      ${isAutoClose ? `<script>alert("${title}"); window.close();</script>` : ""}
    </body>
  </html>`, { headers: { "Content-Type": "text/html" } });

/* ======== OAUTH ======== */
function auth(params, env) {
  const shop = params.get("shop");
  return Response.redirect(`https://${shop}/admin/oauth/authorize?client_id=${env.SHOPIFY_CLIENT_ID}&scope=read_orders,write_orders,write_draft_orders&redirect_uri=${encodeURIComponent(env.APP_URL + "/auth/callback")}`, 302);
}

async function callback(params, env) {
  const shop = params.get("shop"), code = params.get("code");
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
  const shop = params.get("shop"), id = params.get("draftOrderId"), action = params.get("decision"), confirmed = params.get("confirm");
  if (!shop || !id || !action) return new Response("Missing params", { status: 400 });

  return env.SHOPIFY_ACCESS_TOKEN.get(shop).then(token => {
    if (!token) return new Response("Unauthorized", { status: 401 });
    if (action === "reject") return rejectOrder(shop, id, token, env);
    
    return gql(shop, token, env, `query($id: ID!) { draftOrder(id: $id) { tags } }`, { id })
      .then(res => {
        const tags = res.data?.draftOrder?.tags || [];
        if (tags.includes("rejected") && !confirmed) {
          const approveUrl = `${env.APP_URL}/order/decision?shop=${shop}&draftOrderId=${encodeURIComponent(id)}&decision=approve&confirm=true`;
          return html("Previously Rejected", `
            <p>This draft order is tagged as <b>rejected</b>. Do you want to override this and approve it anyway?</p>
            <a href="${approveUrl}" class="btn btn-primary">Yes, Approve</a>
            <button onclick="window.close()" class="btn btn-secondary">No, Cancel</button>
          `, false);
        }
        return completeOrder(shop, id, token, env, tags.filter(t => t !== "rejected"));
      });
  });
}

/* ======== HELPERS & ACTIONS ======== */
async function gql(shop, token, env, query, variables) {
  return fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  }).then(res => res.json());
}

async function completeOrder(shop, id, token, env, newTags) {
  return gql(shop, token, env, `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { draftOrder { id } } }`, { id, input: { tags: newTags } })
    .then(() => gql(shop, token, env, `mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { order { name } } userErrors { message } } }`, { id }))
    .then(res => {
      const err = res.data?.draftOrderComplete?.userErrors?.[0]?.message;
      return err ? html("Error", `<p>${err}</p>`) : html("Success", `<p>Order ${res.data.draftOrderComplete.draftOrder.order.name} has been created.</p>`);
    })
    .catch(err => new Response(err.message, { status: 500 }));
}

async function rejectOrder(shop, id, token, env) {
  return gql(shop, token, env, `query($id: ID!) { draftOrder(id: $id) { status } }`, { id })
    .then(res => {
      if (res.data?.draftOrder?.status === "COMPLETED") return html("Action Restricted", "<p>This order is already approved and cannot be rejected.</p>");
      return gql(shop, token, env, `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { userErrors { message } } }`, { id, input: { tags: ["rejected"] } })
        .then(res => res.data?.draftOrderUpdate?.userErrors?.length ? html("Error", "<p>Update failed.</p>") : html("Rejected", "<p>The order has been tagged as rejected.</p>"));
    })
    .catch(err => new Response(err.message, { status: 500 }));
}
