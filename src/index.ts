interface Env {
  X_API_KEY: string
  API_URL: string
  ORIGIN: string
  REFERER: string
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env))
  },
}

async function run(env: Env) {
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort("timeout"), 28000)
  try {
    const res = await fetch(env.API_URL, {
      method: "GET",
      headers: {
        "accept": "*/*",
        "accept-language": "vi,en-US;q=0.9,en;q=0.8,fr;q=0.7,zh-CN;q=0.6,zh;q=0.5,ja;q=0.4,de;q=0.3,th;q=0.2,zh-TW;q=0.1,es;q=0.1,gl;q=0.1,ru;q=0.1,it;q=0.1,ko;q=0.1,id;q=0.1",
        "dnt": "1",
        "origin": env.ORIGIN,
        "priority": "u=1, i",
        "referer": env.REFERER,
        "sec-ch-ua": "\"Google Chrome\";v=\"141\", \"Not?A_Brand\";v=\"8\", \"Chromium\";v=\"141\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"macOS\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        "x-api-key": env.X_API_KEY,
      },
      signal: controller.signal,
    })

    const body = await res.text()
    console.log(JSON.stringify({ ok: res.ok, status: res.status, len: body.length, preview: body.slice(0, 512) }))
    if (!res.ok) throw new Error(`HTTP_${res.status}`)
  } finally {
    clearTimeout(to)
  }
}
