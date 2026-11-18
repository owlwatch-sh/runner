// Owlwatch runner picker. docs/runner-fallback.md is the design.
//
// Asks the Owlwatch server whether it is healthy and has each wanted label, and
// writes either that label or the customer's fallback as an output. It fails
// open: any error, refusal or silence chooses the fallback, because the case
// this exists for is Owlwatch being down. Every output is one of the labels the
// workflow itself wrote; the server's answer is a verdict, never a label.
//
// No dependencies, so nothing is installed or bundled per run.
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')

const CONNECT_TIMEOUT_MS = 2_000
// Measured: a staging round trip took 3.5-4.2 s in 2 of 8 calls.
const REQUEST_TIMEOUT_MS = 10_000
const RETRY_MS = 10_000
// The server says how long to ride out an unhealthy Owlwatch; never longer than
// this, so the job's timeout-minutes backstop (35) stays out of reach.
const MAX_GRACE_MS = 30 * 60_000
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function parseRoutes(env) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] || '').trim()
  const want = input('want')
  const fallback = input('fallback')
  const routes = input('routes')
  const out = []
  if (routes) {
    if (want || fallback) throw new Error('use either routes or want/fallback, not both')
    for (const raw of routes.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^([^:\s]+)\s*:\s*(\S+)\s*->\s*(\S+)$/.exec(line)
      if (!m) throw new Error(`route line not "key: want -> fallback": ${line}`)
      out.push({ key: m[1], want: m[2], fallback: m[3] })
    }
  } else {
    out.push({ key: 'runner', want, fallback })
  }
  if (out.length === 0) throw new Error('no routes')
  const seen = new Set()
  for (const r of out) {
    if (!KEY.test(r.key) || seen.has(r.key)) throw new Error(`bad or repeated route key: ${r.key}`)
    seen.add(r.key)
    if (!LABEL.test(r.want)) throw new Error(`bad want label for ${r.key}: ${r.want}`)
    if (!LABEL.test(r.fallback)) throw new Error(`bad fallback label for ${r.key}: ${r.fallback}`)
    // A fallback Owlwatch would also serve is no fallback: every Owlwatch
    // runner carries its owlwatch- labels and self-hosted.
    if (/^owlwatch-/i.test(r.fallback) || r.fallback.toLowerCase() === 'self-hosted') {
      throw new Error(`fallback for ${r.key} must be your own runners, not ${r.fallback}`)
    }
  }
  return out
}

function serverURL(raw) {
  const u = new URL(raw)
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('server must be https')
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('server must be an origin, with no path')
  }
  return u
}

// request is one HTTP exchange with a connect timeout separate from the
// overall one: a black-holed Owlwatch should cost two seconds, a slow one ten.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > 64 << 10) req.destroy(new Error('response too large'))
        else chunks.push(c)
      })
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    const fail = (why) => req.destroy(new Error(why))
    const connect = setTimeout(() => fail('connect timed out'), CONNECT_TIMEOUT_MS)
    const overall = setTimeout(() => fail('timed out'), REQUEST_TIMEOUT_MS)
    req.on('socket', (s) => {
      const connected = () => clearTimeout(connect)
      if (!s.connecting) connected()
      s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    req.on('error', reject)
    req.on('close', () => {
      clearTimeout(connect)
      clearTimeout(overall)
    })
    req.end(body)
  })
}

async function idToken(env, audience) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) throw new Error('no OIDC token: the pick job needs `permissions: { id-token: write }`')
  const u = new URL(url)
  u.searchParams.set('audience', audience)
  const res = await request(u, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } })
  if (res.status !== 200) throw new Error(`OIDC token request: HTTP ${res.status}`)
  const value = JSON.parse(res.body).value
  if (typeof value !== 'string' || !value) throw new Error('OIDC token request: no token')
  return value
}

// ask returns the server's verdict per route key: "want", "fallback" or
// "unhealthy", each with a reason, plus how long to ride out "unhealthy".
async function ask(server, token, routes) {
  const body = JSON.stringify({ labels: Object.fromEntries(routes.map((r) => [r.key, r.want])) })
  const res = await request(new URL('/runner/pick', server), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  })
  if (res.status !== 200) throw new Error(`Owlwatch answered HTTP ${res.status}`)
  const parsed = JSON.parse(res.body)
  const verdicts = {}
  for (const r of routes) {
    const v = parsed.labels && parsed.labels[r.key]
    const answer = v && v.answer
    if (answer !== 'want' && answer !== 'fallback' && answer !== 'unhealthy') throw new Error(`Owlwatch gave no answer for ${r.key}`)
    verdicts[r.key] = { answer, reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : '' }
  }
  const grace = Number(parsed.graceSeconds)
  return { verdicts, graceMs: Number.isFinite(grace) && grace > 0 ? Math.min(grace * 1000, MAX_GRACE_MS) : 0 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// decide never throws once the routes are parsed: every failure is a fallback
// with its reason. A route's first final answer (want, or fallback) stands;
// only routes Owlwatch called unhealthy are asked again, until the grace
// period ends.
async function decide(env, routes, { now = Date.now, wait = sleep } = {}) {
  // No prototype: a route may be named anything a key allows, `constructor`
  // included, and must not find an answer it was never given.
  const settled = Object.create(null)
  const settle = (r, label, reason) => { settled[r.key] = { label, reason } }
  const unsettled = () => routes.filter((r) => !settled[r.key])
  const fallbackRest = (reason) => {
    for (const r of unsettled()) settle(r, r.fallback, reason)
    return settled
  }
  let server
  try {
    server = serverURL(env.INPUT_SERVER || 'https://hooks.owlwatch.sh')
  } catch (e) {
    return fallbackRest(e.message)
  }
  const started = now()
  let deadline = null
  let failures = 0
  for (;;) {
    const pending = unsettled()
    let result
    try {
      // A fresh token for every ask: GitHub's last about five minutes, and
      // a grace period can run to thirty.
      let token
      try {
        token = await idToken(env, server.origin)
      } catch (e) {
        if (deadline === null) return fallbackRest(e.message)
        throw e
      }
      result = await ask(server, token, pending)
      failures = 0
    } catch (e) {
      // A Owlwatch that was answering and then stopped gets one more try.
      failures++
      if (deadline === null || failures > 1 || now() >= deadline) {
        return fallbackRest(`Owlwatch unreachable: ${e.message}`)
      }
      await wait(Math.min(RETRY_MS, Math.max(0, deadline - now())))
      continue
    }
    if (deadline === null) deadline = started + result.graceMs
    const why = {}
    for (const r of pending) {
      const v = result.verdicts[r.key]
      if (v.answer === 'want') settle(r, r.want, 'Owlwatch is healthy and has it')
      else if (v.answer === 'fallback') settle(r, r.fallback, v.reason || 'Owlwatch declined')
      else why[r.key] = v.reason
    }
    if (unsettled().length === 0) return settled
    if (now() >= deadline) {
      for (const r of unsettled()) settle(r, r.fallback, `Owlwatch unhealthy past the grace period: ${why[r.key] || 'no reason given'}`)
      return settled
    }
    await wait(Math.min(RETRY_MS, deadline - now()))
  }
}

function writeOutputs(env, routes, chosen) {
  const lines = []
  const summary = ['| Route | Runner | Why |', '|---|---|---|']
  for (const r of routes) {
    const c = chosen[r.key]
    // Belt and braces: an output is only ever one of the workflow's labels.
    const label = c.label === r.want ? r.want : r.fallback
    lines.push(`${r.key}=${label}`)
    summary.push(`| ${r.key} | \`${label}\` | ${c.reason.replace(/[|\n]/g, ' ')} |`)
    const kind = label === r.want ? 'notice' : 'warning'
    process.stdout.write(`::${kind} title=Owlwatch runner (${r.key})::${label}: ${c.reason.replace(/[\r\n%]/g, ' ')}\n`)
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n')
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n')
}

// The fallback issue: one open issue per repository, found by its label, that
// says every time a run fell back and is closed once Owlwatch serves a whole
// run again. So an open issue always means "fell back since last cleared".
// It is written with the workflow's own token, so it works with Owlwatch down;
// the pick job grants `issues: write` for it.
const ISSUE_LABEL = 'owlwatch-runner-fallback'
const ISSUE_TITLE = 'Runner fallback used'

function apiBase(raw) {
  const u = new URL(raw || 'https://api.github.com')
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('GITHUB_API_URL must be https')
  return u.href.replace(/\/$/, '')
}

// kind is why a route fell back, in the words the issue groups them by.
function kind(reason) {
  if (/^Owlwatch unreachable|^no OIDC token|^server must/.test(reason)) return 'Owlwatch unreachable'
  if (/^Owlwatch unhealthy past the grace period/.test(reason)) return 'Owlwatch unhealthy'
  if (/Owlwatch failed a job in this run/.test(reason)) return 'spilled run (Owlwatch failed a job)'
  return 'Owlwatch declined (does not have the label, or not enabled)'
}

const cell = (s) => String(s).replace(/[|\r\n]/g, ' ')

function fallbackComment(env, routes, chosen, at) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const run = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` +
    (env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : '')
  const rows = routes.filter((r) => chosen[r.key].label !== r.want).map((r) =>
    `| ${cell(r.key)} | \`${cell(r.want)}\` → \`${cell(r.fallback)}\` | ${cell(kind(chosen[r.key].reason))} | ${cell(chosen[r.key].reason)} |`)
  return [
    `**${at}**: workflow **${cell(env.GITHUB_WORKFLOW || '?')}**, [run ${env.GITHUB_RUN_ID || '?'}` +
      `${env.GITHUB_RUN_ATTEMPT ? ` attempt ${env.GITHUB_RUN_ATTEMPT}` : ''}](${run}), picker job \`${cell(env.GITHUB_JOB || '?')}\`` +
      `${env.GITHUB_REF_NAME ? ` on \`${cell(env.GITHUB_REF_NAME)}\`` : ''}.`,
    '',
    '| Route | Labels | Why | Detail |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

const ISSUE_INTRO = [
  'The Owlwatch runner picker sent jobs to your fallback runners. Each fallback is a comment below.',
  '',
  'This issue is closed by the picker once Owlwatch serves every route of a run again, so while it is open, runs have fallen back since it was last cleared. Turn it off with `alert: false` on the picker step.',
].join('\n')

// alert opens, comments on or closes the fallback issue for this run's
// verdicts. It never throws and never changes the outputs: it returns what it
// did, or why it could not, for the job summary.
async function alert(env, routes, chosen, { now = () => new Date() } = {}) {
  if ((env.INPUT_ALERT || 'true').trim().toLowerCase() === 'false') return ''
  const fellBack = routes.some((r) => chosen[r.key].label !== r.want)
  try {
    const token = (env.INPUT_TOKEN || '').trim()
    if (!token) throw new Error('no token')
    if (!/^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('GITHUB_REPOSITORY is not set')
    const base = `${apiBase(env.GITHUB_API_URL)}/repos/${env.GITHUB_REPOSITORY}`
    const gh = async (method, path, body) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const res = await request(new URL(base + path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'owlwatch-runner-picker',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        },
        body: data,
      })
      if (res.status < 200 || res.status > 299) {
        const hint = res.status === 403 || res.status === 404 ? ' (does the pick job grant `issues: write`?)' : ''
        throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}${hint}`)
      }
      return res.body ? JSON.parse(res.body) : null
    }
    // GitHub lists pull requests as issues, and anyone may put the label on
    // one: skip them, reading on while a whole page was pull requests.
    let issue = null
    for (let page = 1; page <= 10 && !issue; page++) {
      const open = await gh('GET', `/issues?state=open&labels=${ISSUE_LABEL}&sort=created&direction=asc&per_page=100&page=${page}`)
      if (!Array.isArray(open)) break
      issue = open.find((i) => i && !i.pull_request && Number.isInteger(i.number)) || null
      if (open.length < 100) break
    }
    if (!fellBack) {
      if (!issue) return ''
      await gh('POST', `/issues/${issue.number}/comments`, {
        body: `**${now().toISOString()}**: Owlwatch served every route of run ${env.GITHUB_RUN_ID || '?'} again, so this is closed. It reopens as a new issue the next time a run falls back.`,
      })
      await gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
      return `Closed fallback issue #${issue.number}: Owlwatch is serving this repository again.`
    }
    const comment = fallbackComment(env, routes, chosen, now().toISOString())
    if (issue) {
      await gh('POST', `/issues/${issue.number}/comments`, { body: comment })
      return `Noted on fallback issue #${issue.number}.`
    }
    const created = await gh('POST', '/issues', { title: ISSUE_TITLE, body: ISSUE_INTRO, labels: [ISSUE_LABEL] })
    // GitHub drops labels it will not let this token set, without an error;
    // the issue would then never be found again and every fallback would open
    // another. Add it explicitly, and say so if that is refused too.
    let note = ''
    if (!(created.labels || []).some((l) => (typeof l === 'string' ? l : l && l.name) === ISSUE_LABEL)) {
      try {
        await gh('POST', `/issues/${created.number}/labels`, { labels: [ISSUE_LABEL] })
      } catch (e) {
        note = ` Could not label it ${ISSUE_LABEL} (${e.message}), so the next fallback may open another.`
      }
    }
    await gh('POST', `/issues/${created.number}/comments`, { body: comment })
    return `Opened fallback issue #${created.number}.${note}`
  } catch (e) {
    return fellBack || !/no token/.test(e.message)
      ? `Could not ${fellBack ? 'write' : 'check'} the fallback issue: ${e.message}. The picker's answer stands.`
      : ''
  }
}

async function main(env = process.env) {
  let routes
  try {
    routes = parseRoutes(env)
  } catch (e) {
    // A malformed step has no fallback to fall back to: fail the job, loudly.
    process.stdout.write(`::error title=Owlwatch runner::${e.message}\n`)
    return 1
  }
  const chosen = await decide(env, routes)
  writeOutputs(env, routes, chosen)
  // After the outputs: nothing about the issue may hold up or change the pick.
  let said = ''
  try {
    said = await alert(env, routes, chosen)
  } catch (e) {
    said = `Could not write the fallback issue: ${e && e.message}`
  }
  if (said) {
    process.stdout.write(`${said.replace(/[\r\n]/g, ' ')}\n`)
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${said}\n`)
      } catch {
        // The summary is a courtesy; the outputs are already written.
      }
    }
  }
  return 0
}

module.exports = { parseRoutes, serverURL, decide, writeOutputs, alert, main }

if (require.main === module) {
  // Exit as soon as the outputs are written: an abandoned connection must not
  // hold the step open (measured: 11 s idle without this, 3 s with it).
  main().then((code) => process.exit(code), (e) => {
    process.stdout.write(`::error title=Owlwatch runner::${e && e.message}\n`)
    process.exit(1)
  })
}
