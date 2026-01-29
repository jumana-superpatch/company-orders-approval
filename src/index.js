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
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const code = url.searchParams.get("code");

    if (!shop || !code) {
      return new Response("Invalid callback", { status: 400 });
    }

    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        code
      }).toString()
    });

    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return new Response(
        `OAuth token response not JSON:\n${text}`,
        { status: 500 }
      );
    }

    if (!data.access_token) {
      return new Response(
        `OAuth failed:\n${JSON.stringify(data)}`,
        { status: 500 }
      );
    }

    await env.SHOPIFY_ACCESS_TOKEN.put(shop, data.access_token);

    return new Response("App installed successfully");
  } catch (err) {
    return new Response(
      `OAuth callback error:\n${err.message}`,
      { status: 500 }
    );
  }
}


/* ================= ORDER DECISION ================= */

async function decision(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { shop, draftOrderId, decision } = await request.json();

  if (!shop || !draftOrderId || !decision) {
    return new Response("Missing data", { status: 400 });
  }

  const token = await env.SHOPIFY_ACCESS_TOKEN.get(shop);
  if (!token) return new Response("Unauthorized", { status: 401 });

  if (decision === "approve") {
    return completeDraftOrder(shop, draftOrderId, token, env);
  }

  if (decision === "reject") {
    return deleteDraftOrder(shop, draftOrderId, token, env);
  }

  return new Response("Invalid decision", { status: 400 });
}

/* ================= DRAFT ORDER ACTIONS ================= */

async function completeDraftOrder(shop, draftOrderId, token, env) {
  const res = await fetch(
    `https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
          mutation ($id: ID!) {
            draftOrderComplete(id: $id) {
              draftOrder {
                id
                name
                completedAt
                order {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          id: draftOrderId
        }
      })
    }
  );

  const data = await res.json();

  if (data.errors || data.data.draftOrderComplete.userErrors.length) {
    return new Response(
      JSON.stringify(data),
      { status: 500 }
    );
  }

  return new Response("Draft order approved and completed");
}

async function deleteDraftOrder(shop, draftOrderId, token, env) {
  const res = await fetch(
    `https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
          mutation ($id: ID!) {
            draftOrderDelete(id: $id) {
              deletedId
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          id: draftOrderId
        }
      })
    }
  );

  const data = await res.json();

  if (data.errors || data.data.draftOrderDelete.userErrors.length) {
    return new Response(
      JSON.stringify(data),
      { status: 500 }
    );
  }

  return new Response("Draft order rejected and deleted");
}