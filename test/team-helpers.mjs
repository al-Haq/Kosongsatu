// Helpers for the team module tests: sign in as invited users.
export const memberPassword = "Member-test-password-31";

export function signIn(f, email, password = memberPassword, code) {
  return f
    .request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(code ? { code } : {}) }),
    })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
      const cookie = res.headers.get("set-cookie").split(";")[0];
      const auth = (path, method = "GET", body) =>
        f.request(path, {
          method,
          headers: {
            Cookie: cookie,
            "X-CSRF-Token": data.csrf,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const json = async (path, method = "GET", body) => {
        const r = await auth(path, method, body);
        const out = await r.json();
        if (!r.ok) throw Object.assign(new Error(out.error), { status: r.status });
        return out;
      };
      return { auth, json, cookie, csrf: data.csrf, email };
    });
}

// Invites a user as the fixture owner, accepts the invitation and signs in.
export async function member(f, role, email = `${role}-${Math.random().toString(36).slice(2, 7)}@example.com`) {
  const invite = await f.json("/api/team/users", "POST", { email, role, name: role + " user" });
  const token = invite.link.split("/invite/")[1];
  const res = await f.request("/api/guest/team/invite/" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: memberPassword }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return { ...(await signIn(f, email)), id: invite.user.id, token };
}

// A fake SMTP transport that records messages.
export function fakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      sent.push(m);
      return { messageId: "<" + sent.length + "@test>" };
    },
  };
}
export const mailConfig = { host: "smtp.example.com", port: 587, from: "Billing <billing@example.com>" };
