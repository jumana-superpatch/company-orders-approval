export default {
  fetch(req, env) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/auth") return auth(searchParams, env);
    if (pathname === "/auth/callback") return callback(searchParams, env);
    if (pathname === "/order/decision") return decision(searchParams, env);
    return new Response("Not Found", { status: 404 });
  }
};

const html = (msg, script = "") => new Response(`
  <body style="font-family:sans-serif;text-align:center;padding-top:50px;">
    <h2>${msg}</h2>
    ${script || `<script>alert("${msg}"); window.close();</script>`}
  </body>`, { headers: { "Content-Type": "text/html" } });

/* ======== OAUTH ======== */
function auth(params, env) {
  const shop = params.get("shop");
  return Response.redirect(`https://${shop}/admin/oauth/authorize?client_id=${env.SHOPIFY_CLIENT_ID}&scope=read_orders,write_orders,write_draft_orders&redirect_uri=${encodeURIComponent(env.APP_URL + "/auth/callback")}`, 302);
}

function callback(params, env) {
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
    
    // Approval logic with override check
    return gql(shop, token, env, `query($id: ID!) { draftOrder(id: $id) { tags } }`, { id })
      .then(res => {
        const tags = res.data?.draftOrder?.tags || [];
        if (tags.includes("rejected") && !confirmed) {
          return html("This order was previously rejected.", `
            <p>Do you want to override and approve it anyway?</p>
            <button onclick="location.href='${env.APP_URL}/order/decision?shop=${shop}&draftOrderId=${encodeURIComponent(id)}&decision=approve&confirm=true'">Yes, Approve</button>
            <button onclick="window.close()">No, Cancel</button>
          `);
        }
        return completeOrder(shop, id, token, env, tags.filter(t => t !== "rejected"));
      });
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

function completeOrder(shop, id, token, env, newTags) {
  // Update tags first to remove 'rejected', then complete
  return gql(shop, token, env, `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { draftOrder { id } } }`, { id, input: { tags: newTags } })
    .then(() => gql(shop, token, env, `mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { order { name } } userErrors { message } } }`, { id }))
    .then(res => {
      const err = res.data?.draftOrderComplete?.userErrors?.[0]?.message;
      return err ? html(`Error: ${err}`) : html(`Order ${res.data.draftOrderComplete.draftOrder.order.name} Approved!`);
    })
    .catch(err => new Response(err.message, { status: 500 }));
}

function rejectOrder(shop, id, token, env) {
  return gql(shop, token, env, `query($id: ID!) { draftOrder(id: $id) { status } }`, { id })
    .then(res => {
      if (res.data?.draftOrder?.status === "COMPLETED") return html("Cannot Reject: Order already approved.");
      return gql(shop, token, env, `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) { userErrors { message } } }`, { id, input: { tags: ["rejected"] } })
        .then(res => res.data?.draftOrderUpdate?.userErrors?.length ? html("Update failed") : html("Order Rejected Successfully"));
    })
    .catch(err => new Response(err.message, { status: 500 }));
}
