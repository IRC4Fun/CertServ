const fs = require("fs")
const tls = require("tls")
const IRC = require("irc-framework")
const statsRegexp = /^\*\*\* Listener on .+:([0-9]+) \(IPv(?:4|6)\): has [0-9]+ client\(s\), options: (.*)$/
let config = JSON.parse(fs.readFileSync(__dirname + "/config.json"))
let state = {
    expiryState: {},
    networkState: {},
    expiryLastUpdated: Date.now(),
    networkLastUpdated: Date.now()
}
if (fs.existsSync(__dirname + "/data.json")) {
    state = JSON.parse(fs.readFileSync(__dirname + "/data.json"))
} else {
    saveState()
}
let temp = {
    expiryState: null,
    queue: [],
    networkState: null,
    pendingStats: new Set(),
    refreshCallbacks: [],
    rev: 0,
    inProgress: 0,
    isRefreshAll: false
}
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0
function log(str, ...args) {
    if (config.log) {
        console.log(str, ...args)
    }
}
const bot = new IRC.Client({
    nick: config.user.nick,
    username: config.user.ident,
    gecos: config.user.gecos,
    version: "CertServ",
    host: config.server.host,
    tls: config.server.secure,
    port: config.server.port
})
bot.on("registered", () => {
    bot.raw("oper", config.user.oper.name, config.user.oper.password)
    config.channels.forEach(channel => {
        bot.join(channel)
    })
    refreshState()
})
function saveState() {
    fs.writeFileSync(__dirname + "/data.json", JSON.stringify(state))
    log("Persisted data to disk")
}
function refreshState() {
    bot.raw("links")
    log("Refreshing network state")
}
bot.on("server links", (links) => {
    log("Got link data")
    let servers = new Set()
    let rev = ++temp.rev
    temp.networkState = {}
    temp.pendingStats = new Set()
    links.links.forEach(link => {
        servers.add(link.address)
        servers.add(link.access_via)
    })
    servers = [...servers]
    log("Got %s servers", servers.length)
    servers.forEach(el => {
        temp.networkState[el] = {
            c2s: [],
            s2s: []
        }
        temp.pendingStats.add(el)
        bot.raw("stats", "P", el)
    })
    setTimeout(() => {
        if (rev !== temp.rev) return
        let deleted = 0
        for (let i of temp.pendingStats) {
            delete temp.networkState[i]
            deleted++
        }
        temp.pendingStats.clear()
        state.networkState = temp.networkState
        state.networkLastUpdated = Date.now()
        temp.networkState = null
        saveState()
        log("State refresh complete with %s not responding", deleted)
        temp.refreshCallbacks.forEach(cb => cb())
        temp.refreshCallbacks = []
    }, 3000)
})
bot.on("notice", notice => {
    let match
    if (notice.from_server && notice.target === config.user.nick && temp.pendingStats.has(notice.hostname) && (match = notice.message.match(statsRegexp))) {
        let server = notice.hostname
        let opts = match[2].replace(/ +$/, "").split(" ")
        let port = +match[1]
        if (!opts.includes("tls")) return
        let arr = temp.networkState[server][opts.includes("serversonly") ? "s2s" : "c2s"]
        if (!arr.includes(port)) {
            arr.push(port)
        }
    }
})
bot.on("raw", line => {
    if (!line.from_server) return
    let match
    if (match = line.line.match(/:([^ ]+) 219 [^ ]+ P :End of \/STATS report\r?\n/)) {
        temp.pendingStats.delete(match[1])
    }
})

bot.on("privmsg", msg => {
    if (msg.batch && msg.batch.type === "chathistory") return
    if (config.channels.includes(msg.target) && msg.message.length > config.prefix.length && msg.message.startsWith(config.prefix)) {
        let args = msg.message.slice(config.prefix.length).split(" ")
        let cmd = args.shift()
        switch (cmd) {
            case "help": {
                msg.reply("CertServ is a utility to view information about certificate expiry.")
                msg.reply("Source: https://git.semisol.dev/Semisol/CertServ")
                msg.reply("  help: Get this message")
                msg.reply("  refreshnet: Refresh network state")
                msg.reply("  refresh <server>: Refresh a server")
                msg.reply("  check <server>: Check a server")
                msg.reply("  refreshall: Refresh all servers")
                msg.reply("  info: Show information about the bot, and statistics")
                msg.reply("  expired: Show expired certificates")
                msg.reply("  expiringsoon: Show certificates expiring in 7 days")
                break
            }
            case "refresh": {
                if (args.length === 0) {
                    msg.reply(`ERROR: Please provide a server argument`)
                    return
                }
                if (!state.networkState[args[0]]) {
                    msg.reply(`ERROR: No such server`)
                    return
                }
                let ports = state.networkState[args[0]]
                temp.expiryState = {...state.expiryState}
                delete temp.expiryState[args[0]]
                for (let i of ports.c2s) {
                    temp.queue.push({
                        server: args[0],
                        addr: config.overrideHost[args[0]] || args[0],
                        port: i,
                        type: "c2s"
                    })
                }
                for (let i of ports.s2s) {
                    temp.queue.push({
                        server: args[0],
                        addr: config.overrideHost[args[0]] || args[0],
                        port: i,
                        type: "s2s"
                    })
                }
                msg.reply(`Added ${ports.s2s.length + ports.c2s.length} jobs`)
                break
            }
            case "refreshnet": {
                temp.refreshCallbacks.push(function () {
                    msg.reply("Done!")
                })
                msg.reply("Please wait...")
                refreshState()
                break
            }
            case "refreshall": {
                let jobs = 0
                let servers = 0
                temp.expiryState = {}
                temp.isRefreshAll = true
                Object.keys(state.networkState).forEach(srv => {
                    let ports = state.networkState[srv]
                    for (let i of ports.c2s) {
                        temp.queue.push({
                            server: srv,
                            addr: config.overrideHost[srv] || srv,
                            port: i,
                            type: "c2s"
                        })
                        jobs++
                    }
                    for (let i of ports.s2s) {
                        temp.queue.push({
                            server: srv,
                            addr: config.overrideHost[srv] || srv,
                            port: i,
                            type: "s2s"
                        })
                        jobs++
                    }
                    servers++
                })
                msg.reply(`Added ${jobs} jobs (${servers} servers)`)
                log("Refreshing all...")
                break
            }
            case "check": {
                if (args.length === 0) {
                    msg.reply(`ERROR: Please provide a server argument`)
                    return
                }
                if (!state.expiryState[args[0]]) {
                    if (!state.networkState[args[0]]) {
                        msg.reply(`ERROR: No such server`)
                    } else {
                        msg.reply(`ERROR: Please \`refresh\` the server, as it has not been processed yet.`)
                    }
                    return
                }
                let seenInvalid = false
                msg.reply(`Server information for ${args[0]}:`)
                state.expiryState[args[0]].checks.forEach(check => {
                    let addr = `${args[0] === check.addr ? `Port ` : `${check.addr}:`}${check.port} (${check.type.toUpperCase()})`
                    switch (check.status) {
                        case "success": {
                            if (check.expiryTS > Date.now()) {
                                if (check.valid) seenInvalid = true
                                msg.reply(`  ${addr}: Expires in ${((check.expiryTS - Date.now()) / 86400000).toFixed(2)}d (${check.expiry})${check.valid ? "" : " (!)"}`)
                            } else {
                                msg.reply(`  ${addr}: Expired ${((Date.now() - check.expiryTS) / 86400000).toFixed(2)}d ago (${check.expiry})`)
                            }
                            break
                        }
                        case "timeout": {
                            msg.reply(`  ${addr}: Timed out while connecting`)
                            break
                        }
                        case "error": {
                            msg.reply(`  ${addr}: Encountered error while connecting`)
                            break
                        }
                    }
                })
                if (seenInvalid) msg.reply(`(!): Self signed, wrong domain or something else`)
                break
            }
            case "info": {
                msg.reply(`CertServ version 1.0.0`)
                if (temp.pendingStats.length > 0) {
                    msg.reply(`Network refresh: Waiting for ${temp.pendingStats.length} server${temp.pendingStats.length === 1 ? "" : "s"}`)
                } else if (temp.networkState) {
                    msg.reply(`Network refresh: Waiting...`)
                }
                if (temp.queue.length > 0 || temp.inProgress > 0) {
                    msg.reply(`Expiry refresh: ${temp.queue.length} in queue`)
                    msg.reply(`Expiry refresh: Waiting for ${temp.inProgress} connection${temp.inProgress === 1 ? "" : "s"}`)
                    msg.reply(`Expiry refresh: Processing ${config.rate} job${config.rate === 1 ? "" : "s"} per second`)
                }
                msg.reply(`Network state: ${Object.keys(state.networkState).length} servers`)
                msg.reply(`Network state: Last updated ${((Date.now() - state.networkLastUpdated) / 1000 / 60).toFixed(2)}m ago`)
                msg.reply(`Expiry state: ${Object.keys(state.expiryState).length} servers`)
                msg.reply(`Expiry state: Last updated ${((Date.now() - state.expiryLastUpdated) / 1000 / 60 / 60).toFixed(2)}h ago`)
                if (temp.expiryState && temp.queue.length === 0 && temp.inProgress === 0)
                    msg.reply(`WARNING: No jobs are running but a transient state exists`)
                break
            }
            case "expiringsoon": {
                let checks = []
                msg.reply(`Certificates expiring soon:`)
                Object.keys(state.expiryState).forEach(srv => {
                    state.expiryState[srv].checks.forEach(check => {
                        if (check.status !== "success") return
                        if (check.expiryTS < (Date.now() + (7 * 24 * 60 * 60 * 1000)) && check.expiryTS > Date.now()) {
                            checks.push({...check, server: srv})
                        }
                    })
                })
                checks.sort((b, a) => a.expiryTS - b.expiryTS)
                checks.forEach(check => {
                    let addr = `${check.addr}:${check.port}${check.server !== check.addr ? ` (${check.server})` : `` } (${check.type.toUpperCase()})`
                    msg.reply(`  ${addr}, in ${((check.expiryTS - Date.now()) / 86400000).toFixed(2)}d`)
                })
                if (checks.length === 0) msg.reply("None! \\o/")
                break
            }
            case "expired": {
                let checks = []
                msg.reply(`Certificates that expired:`)
                Object.keys(state.expiryState).forEach(srv => {
                    state.expiryState[srv].checks.forEach(check => {
                        if (check.status !== "success") return
                        if (check.expiryTS < Date.now()) {
                            checks.push({...check, server: srv})
                        }
                    })
                })
                checks.sort((b, a) => a.expiryTS - b.expiryTS)
                checks.forEach(check => {
                    let addr = `${check.addr}:${check.port}${check.server !== check.addr ? ` (${check.server})` : `` } (${check.type.toUpperCase()})`
                    msg.reply(`  ${addr}, ${((Date.now() - check.expiryTS) / 86400000).toFixed(2)}d ago`)
                })
                if (checks.length === 0) msg.reply("None! \\o/")
                break
            }
        }
    }
})

setInterval(() => {
    if (temp.queue.length > 0) {
        if (!temp.expiryState) {
            temp.expiryState = { ...state.expiryState }
            log("Copying original state to transient")
        }
        let job = temp.queue.shift()
        log("Starting job %s, %s:%s, %s", job.server, job.addr, job.port, job.type)
        temp.inProgress++
        let hasFinished = false
        let res = {
            addr: job.addr,
            type: job.type,
            port: job.port,
            status: "unknown"
        }
        function jobEnded() {
            temp.inProgress--
            hasFinished = true
            log("Ended job %s, %s:%s, %s with status %s", job.server, job.addr, job.port, job.type, res.status)
            if (!temp.expiryState[job.server]) {
                temp.expiryState[job.server] = {
                    checks: []
                }
            }
            temp.expiryState[job.server].checks.push(res)
            if (temp.inProgress === 0 && temp.queue.length === 0) {
                log("Replaced original state with transient state")
                state.expiryState = temp.expiryState
                temp.expiryState = null
                saveState()
            }
        }
        let conn = tls.connect({
            host: job.server,
            port: job.port,
            timeout: config.timeout
        }, () => {
            if (hasFinished) return
            let cert = conn.getPeerX509Certificate()
            res.status = "success"
            res.expiry = cert.validTo
            res.expiryTS = +new Date(cert.validTo)
            res.valid = conn.authorized
            jobEnded()
            conn.end()
        })
        conn.on("error", () => {
            if (hasFinished) return
            res.status = "error"
            jobEnded()
            conn.end()
        })
        conn.on("timeout", () => {
            if (hasFinished) return
            res.status = "timeout"
            jobEnded()
            conn.end()
        })
    }
}, 1000 / config.rate)

bot.connect()