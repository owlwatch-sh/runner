'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { parseRoutes, serverURL, decide, writeOutputs, alert, main } = require('./index.js')

// stub serves the OIDC token endpoint and /runner/pick, answering pick with
// each successive entry of answers (the last repeats).
async function stub(answers) {
  const seen = { picks: [], audiences: [] }
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) {
      seen.audiences.push(new URL(req.url, 'http://x').searchParams.get('audience'))
      res.end(JSON.stringify({ value: 'oidc-token' }))
      return
    }
    // Only the pick endpoint answers: a picker that asked anywhere else would
    // otherwise pass every test.
    if (req.method !== 'POST' || req.url !== '/runner/pick') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.picks.push({ auth: req.headers.authorization, body: JSON.parse(body) })
      const a = answers[Math.min(seen.picks.length - 1, answers.length - 1)]
      if (typeof a === 'number') {
        res.statusCode = a
        res.end()
        return
      }
      res.end(JSON.stringify(a))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}`
  return {
    seen,
    env: (extra = {}) => ({
      INPUT_SERVER: origin,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
      ...extra,
    }),
    close: () => new Promise((r) => srv.close(r)),
  }
}

// A fake clock: waiting advances it instead of sleeping.
function clock() {
  let t = 1_000_000
  return { now: () => t, wait: async (ms) => void (t += ms) }
}

const one = parseRoutes({ INPUT_WANT: 'owlwatch-macos', INPUT_FALLBACK: 'macos-15' })
const verdict = (answer, reason = '', graceSeconds = 180) => ({ labels: { runner: { answer, reason } }, graceSeconds })

test('routes: want/fallback or a routes block, never both, labels checked', () => {
  assert.deepEqual(one, [{ key: 'runner', want: 'owlwatch-macos', fallback: 'macos-15' }])
  assert.deepEqual(parseRoutes({ INPUT_ROUTES: 'linux: owlwatch-linux -> ubuntu-latest\n# c\n\nmac: owlwatch-macos -> macos-15' }), [
    { key: 'linux', want: 'owlwatch-linux', fallback: 'ubuntu-latest' },
    { key: 'mac', want: 'owlwatch-macos', fallback: 'macos-15' },
  ])
  assert.throws(() => parseRoutes({ INPUT_ROUTES: 'a: x -> y', INPUT_WANT: 'x' }))
  assert.throws(() => parseRoutes({ INPUT_WANT: 'owlwatch-linux' }), /fallback/)
  assert.throws(() => parseRoutes({ INPUT_WANT: 'a b', INPUT_FALLBACK: 'c' }))
  assert.throws(() => parseRoutes({ INPUT_ROUTES: 'a: x -> y\na: x -> z' }), /repeated/)
  // A fallback Owlwatch would serve too is no fallback.
  assert.throws(() => parseRoutes({ INPUT_WANT: 'owlwatch-linux', INPUT_FALLBACK: 'owlwatch-macos' }), /your own runners/)
  assert.throws(() => parseRoutes({ INPUT_WANT: 'owlwatch-linux', INPUT_FALLBACK: 'self-hosted' }), /your own runners/)
})

test('server: https origin only, http just for loopback', () => {
  assert.equal(serverURL('https://hooks.owlwatch.sh').origin, 'https://hooks.owlwatch.sh')
  assert.ok(serverURL('http://127.0.0.1:8080'))
  assert.throws(() => serverURL('http://hooks.owlwatch.sh'))
  assert.throws(() => serverURL('https://hooks.owlwatch.sh/x'))
  assert.throws(() => serverURL('https://u:p@hooks.owlwatch.sh'))
})

test('healthy Owlwatch: want, asked once, token for the server origin', async () => {
  const s = await stub([verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'owlwatch-macos')
    assert.equal(s.seen.picks.length, 1)
    assert.equal(s.seen.picks[0].auth, 'Bearer oidc-token')
    assert.deepEqual(s.seen.picks[0].body, { labels: { runner: 'owlwatch-macos' } })
    assert.deepEqual(s.seen.audiences, [s.env().INPUT_SERVER])
  } finally {
    await s.close()
  }
})

test('label not offered: fallback at once, with the reason', async () => {
  const s = await stub([verdict('fallback', 'no host offers owlwatch-macos')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /no host offers/)
    assert.equal(s.seen.picks.length, 1)
  } finally {
    await s.close()
  }
})

test('unhealthy then healthy inside the grace period: want', async () => {
  const s = await stub([verdict('unhealthy', 'host restarting'), verdict('unhealthy'), verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'owlwatch-macos')
    assert.equal(s.seen.picks.length, 3)
  } finally {
    await s.close()
  }
})

test('unhealthy past the grace period: fallback, without asking past it', async () => {
  const s = await stub([verdict('unhealthy', 'no host connected', 60)])
  try {
    const c = clock()
    const start = c.now()
    const got = await decide(s.env(), one, c)
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /grace period: no host connected/)
    assert.ok(c.now() - start <= 60_000)
    assert.ok(s.seen.picks.length >= 2 && s.seen.picks.length <= 7)
  } finally {
    await s.close()
  }
})

test('grace is capped at 30 minutes whatever the server says', async () => {
  const s = await stub([verdict('unhealthy', 'x', 86_400)])
  try {
    const c = clock()
    const start = c.now()
    await decide(s.env(), one, c)
    // Waits out the whole thirty minutes, and not a moment past it.
    assert.ok(c.now() - start <= 30 * 60_000)
    assert.ok(c.now() - start >= 30 * 60_000 - 10_000, `stopped at ${c.now() - start} ms`)
  } finally {
    await s.close()
  }
})

test('Owlwatch errors or unreachable: fallback', async () => {
  for (const answer of [500, 404, { labels: {} }, { labels: { runner: { answer: 'ubuntu-latest' } } }]) {
    const s = await stub([answer])
    try {
      const got = await decide(s.env(), one, clock())
      assert.equal(got.runner.label, 'macos-15', JSON.stringify(answer))
    } finally {
      await s.close()
    }
  }
  // A port nothing listens on.
  const s = await stub([verdict('want')])
  const env = s.env()
  await s.close()
  const got = await decide({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1:9/token' }, one, clock())
  assert.equal(got.runner.label, 'macos-15')
})

test('Owlwatch stopping mid-grace: one more try, then fallback', async () => {
  const s = await stub([verdict('unhealthy'), 503, 503, verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /unreachable/)
    assert.equal(s.seen.picks.length, 3)
  } finally {
    await s.close()
  }
})

test('no id-token permission: fallback naming the fix', async () => {
  const got = await decide({ INPUT_SERVER: 'https://hooks.owlwatch.sh' }, one, clock())
  assert.equal(got.runner.label, 'macos-15')
  assert.match(got.runner.reason, /id-token: write/)
})

test('black-holed Owlwatch costs the connect timeout, not the request timeout', async () => {
  const env = {
    INPUT_SERVER: 'https://10.255.255.1',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
  }
  const s = await stub([verdict('want')])
  try {
    // The token comes from the stub; the pick goes to the black hole.
    env.ACTIONS_ID_TOKEN_REQUEST_URL = s.env().ACTIONS_ID_TOKEN_REQUEST_URL
    const start = Date.now()
    const got = await decide(env, one, clock())
    const took = Date.now() - start
    assert.equal(got.runner.label, 'macos-15')
    // Under the 10 s request timeout: the connect timeout is what ended it.
    // Generous above the 2 s it should take, for a loaded runner.
    assert.ok(took < 9_000, `took ${took} ms`)
  } finally {
    await s.close()
  }
})

test('outputs are only ever the workflow’s own labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'))
  const env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') }
  const routes = parseRoutes({ INPUT_ROUTES: 'a: owlwatch-linux -> ubuntu-latest\nb: owlwatch-macos -> macos-15' })
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    writeOutputs(env, routes, { a: { label: 'owlwatch-linux', reason: 'ok' }, b: { label: 'evil-label', reason: 'x|y' } })
  } finally {
    process.stdout.write = write
  }
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'a=owlwatch-linux\nb=macos-15\n')
  fs.rmSync(dir, { recursive: true })
})

test('a route named like an Object property is still decided', async () => {
  const routes = parseRoutes({ INPUT_ROUTES: 'constructor: owlwatch-linux -> ubuntu-latest' })
  const s = await stub([{ labels: { constructor: { answer: 'fallback', reason: 'no Linux' } }, graceSeconds: 0 }])
  try {
    const got = await decide(s.env(), routes, clock())
    assert.equal(got.constructor.label, 'ubuntu-latest')
    assert.equal(s.seen.picks.length, 1)
  } finally {
    await s.close()
  }
})

test('a fresh token for every ask, since a grace period outlasts one', async () => {
  const s = await stub([verdict('unhealthy'), verdict('unhealthy'), verdict('want')])
  try {
    await decide(s.env(), one, clock())
    assert.equal(s.seen.picks.length, 3)
    assert.equal(s.seen.audiences.length, 3)
  } finally {
    await s.close()
  }
})

test('a grace period shorter than the retry interval is still waited, then asked once more', async () => {
  const s = await stub([verdict('unhealthy', 'restarting', 5), verdict('want')])
  try {
    const c = clock()
    const start = c.now()
    const got = await decide(s.env(), one, c)
    assert.equal(got.runner.label, 'owlwatch-macos')
    assert.equal(c.now() - start, 5_000)
  } finally {
    await s.close()
  }
})

test('a route already answered keeps its answer while another waits', async () => {
  const routes = parseRoutes({ INPUT_ROUTES: 'win: owlwatch-windows -> windows-latest\nmac: owlwatch-macos -> macos-15' })
  const two = (win, mac) => ({ labels: { ...(win && { win }), mac }, graceSeconds: 180 })
  const s = await stub([
    two({ answer: 'fallback', reason: 'no Windows here' }, { answer: 'unhealthy' }),
    two(null, { answer: 'want' }),
  ])
  try {
    const got = await decide(s.env(), routes, clock())
    assert.equal(got.win.label, 'windows-latest')
    assert.match(got.win.reason, /no Windows/)
    assert.equal(got.mac.label, 'owlwatch-macos')
    // The second ask is only about the route still waiting.
    assert.deepEqual(s.seen.picks[1].body, { labels: { mac: 'owlwatch-macos' } })
  } finally {
    await s.close()
  }
})

// github stubs the REST calls the alert makes, holding issues in memory.
// `status` answers every call with that status instead; `dropLabels` creates
// issues without their labels, as GitHub does for a token it won't let set them.
async function github({ issues = [], status = 0, dropLabels = false } = {}) {
  const calls = []
  let next = 100
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      calls.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined })
      const json = (code, v) => { res.statusCode = code; res.end(JSON.stringify(v)) }
      if (status) return json(status, { message: 'nope' })
      const m = /^\/repos\/o\/r\/issues(?:\/(\d+))?(\/comments|\/labels)?$/.exec(u.pathname)
      if (!m) return json(404, {})
      const issue = m[1] && issues.find((i) => i.number === Number(m[1]))
      if (req.method === 'GET' && !m[1]) {
        const label = u.searchParams.get('labels')
        const per = Number(u.searchParams.get('per_page') || 30), page = Number(u.searchParams.get('page') || 1)
        const all = issues.filter((i) => i.state === 'open' && i.labels.some((l) => l.name === label))
        return json(200, all.slice((page - 1) * per, page * per))
      }
      if (req.method === 'POST' && !m[1]) {
        const b = JSON.parse(body)
        const i = { number: next++, state: 'open', title: b.title, body: b.body, labels: dropLabels ? [] : b.labels.map((name) => ({ name })), comments: [] }
        issues.push(i)
        return json(201, i)
      }
      if (!issue) return json(404, {})
      if (m[2] === '/comments') { issue.comments.push(JSON.parse(body).body); return json(201, {}) }
      if (m[2] === '/labels') { issue.labels.push(...JSON.parse(body).labels.map((name) => ({ name }))); return json(200, issue.labels) }
      if (req.method === 'PATCH') { Object.assign(issue, JSON.parse(body)); return json(200, issue) }
      json(404, {})
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    issues,
    calls,
    env: (extra = {}) => ({
      GITHUB_API_URL: `http://127.0.0.1:${srv.address().port}`,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'pick',
      INPUT_TOKEN: 'gh-token',
      ...extra,
    }),
    close: () => new Promise((r) => srv.close(r)),
  }
}

const two = parseRoutes({ INPUT_ROUTES: 'linux: owlwatch-linux -> ubuntu-latest\nmac: owlwatch-macos -> macos-15' })
const fixed = { now: () => new Date('2026-11-17T12:00:00Z') }
const served = { linux: { label: 'owlwatch-linux', reason: 'Owlwatch is healthy and has it' }, mac: { label: 'owlwatch-macos', reason: 'Owlwatch is healthy and has it' } }
const fellBack = {
  linux: { label: 'owlwatch-linux', reason: 'Owlwatch is healthy and has it' },
  mac: { label: 'macos-15', reason: 'Owlwatch unhealthy past the grace period: mini is paused' },
}
const labelled = (number, state = 'open') => ({ number, state, title: 'Runner fallback used', labels: [{ name: 'owlwatch-runner-fallback' }], comments: [] })

test('alert: a fallback with no open issue opens one, labelled, saying when, which run and why', async () => {
  const g = await github()
  try {
    const said = await alert(g.env(), two, fellBack, fixed)
    assert.match(said, /Opened fallback issue #100/)
    assert.equal(g.issues.length, 1)
    const [i] = g.issues
    assert.equal(i.title, 'Runner fallback used')
    assert.deepEqual(i.labels, [{ name: 'owlwatch-runner-fallback' }])
    assert.equal(i.comments.length, 1)
    const c = i.comments[0]
    assert.match(c, /2026-11-17T12:00:00/)
    assert.match(c, /workflow \*\*CI\*\*/)
    assert.match(c, /actions\/runs\/42\/attempts\/2/)
    assert.match(c, /`owlwatch-macos` → `macos-15`/)
    assert.match(c, /Owlwatch unhealthy \| Owlwatch unhealthy past the grace period: mini is paused/)
    // Only the route that fell back is listed.
    assert.doesNotMatch(c, /owlwatch-linux/)
    assert.equal(g.calls[0].auth, 'Bearer gh-token')
  } finally {
    await g.close()
  }
})

test('alert: a fallback with an issue open comments on it, never opens another', async () => {
  const g = await github({ issues: [labelled(7)] })
  try {
    const one = parseRoutes({ INPUT_WANT: 'owlwatch-linux', INPUT_FALLBACK: 'ubuntu-latest' })
    for (const reason of ['Owlwatch unreachable: connect timed out', 'Owlwatch failed a job in this run, so it is re-run on your fallback runners', 'no host offers it']) {
      assert.match(await alert(g.env(), one, { runner: { label: 'ubuntu-latest', reason } }, fixed), /Noted on fallback issue #7/)
    }
    assert.equal(g.issues.length, 1)
    const [unreachable, spilled, declined] = g.issues[0].comments
    assert.match(unreachable, /Owlwatch unreachable \|/)
    assert.match(spilled, /spilled run/)
    assert.match(declined, /does not have the label/)
  } finally {
    await g.close()
  }
})

test('alert: a run Owlwatch served whole closes the open issue with a comment', async () => {
  const g = await github({ issues: [labelled(7)] })
  try {
    assert.match(await alert(g.env(), two, served, fixed), /Closed fallback issue #7/)
    assert.equal(g.issues[0].state, 'closed')
    assert.equal(g.issues[0].state_reason, 'completed')
    assert.match(g.issues[0].comments[0], /served every route of run 42/)
  } finally {
    await g.close()
  }
})

test('alert: a served run with nothing open writes nothing, and a partial fallback never closes', async () => {
  const g = await github()
  try {
    assert.equal(await alert(g.env(), two, served, fixed), '')
    assert.deepEqual(g.calls.map((c) => c.method), ['GET'])
  } finally {
    await g.close()
  }
  const h = await github({ issues: [labelled(7)] })
  try {
    await alert(h.env(), two, fellBack, fixed)
    assert.equal(h.issues[0].state, 'open')
    assert.ok(!h.calls.some((c) => c.method === 'PATCH'))
  } finally {
    await h.close()
  }
})

test('alert: labels GitHub dropped on create are added, so the issue is found next time', async () => {
  const g = await github({ dropLabels: true })
  try {
    await alert(g.env(), two, fellBack, fixed)
    assert.match(await alert(g.env(), two, fellBack, fixed), /Noted on fallback issue #100/)
    assert.equal(g.issues.length, 1)
  } finally {
    await g.close()
  }
})

test('alert: off with alert: false, and never asks GitHub', async () => {
  const g = await github()
  try {
    assert.equal(await alert(g.env({ INPUT_ALERT: 'false' }), two, fellBack, fixed), '')
    assert.equal(g.calls.length, 0)
  } finally {
    await g.close()
  }
})

test('alert fails open: a refused or unreachable GitHub is said, never thrown', async () => {
  const g = await github({ status: 403 })
  try {
    assert.match(await alert(g.env(), two, fellBack, fixed), /Could not write the fallback issue: .*HTTP 403.*issues: write.*answer stands/)
  } finally {
    await g.close()
  }
  const h = await github()
  const env = h.env()
  await h.close()
  assert.match(await alert(env, two, fellBack, fixed), /Could not write the fallback issue/)
  assert.match(await alert({ ...env, INPUT_TOKEN: '' }, two, fellBack, fixed), /no token/)
  assert.equal(await alert({ ...env, INPUT_TOKEN: '' }, two, served, fixed), '')
})

test('main: a fallback whose issue cannot be written still outputs the fallback and succeeds', async () => {
  const s = await stub([{ labels: { runner: { answer: 'fallback', reason: 'no host offers it' } }, graceSeconds: 0 }])
  const g = await github({ status: 403 })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'))
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    const env = { ...s.env(), ...g.env(), INPUT_WANT: 'owlwatch-linux', INPUT_FALLBACK: 'ubuntu-latest',
      GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') }
    assert.equal(await main(env), 0)
    assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'runner=ubuntu-latest\n')
    assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /Could not write the fallback issue: .*HTTP 403/)
  } finally {
    process.stdout.write = write
    fs.rmSync(dir, { recursive: true })
    await s.close()
    await g.close()
  }
})

test('alert: pull requests carrying the label are skipped, however many come first', async () => {
  const pr = (number) => ({ ...labelled(number), pull_request: { url: 'x' } })
  for (const prs of [1, 100]) {
    const g = await github({ issues: [...Array.from({ length: prs }, (_, i) => pr(1000 + i)), labelled(7)] })
    try {
      assert.match(await alert(g.env(), two, fellBack, fixed), /Noted on fallback issue #7/, `${prs} PRs first`)
      assert.equal(g.issues.length, prs + 1, 'no duplicate issue opened')
      assert.match(await alert(g.env(), two, served, fixed), /Closed fallback issue #7/)
      assert.equal(g.issues.filter((i) => i.pull_request).every((i) => i.state === 'open' && i.comments.length === 0), true)
    } finally {
      await g.close()
    }
  }
})
