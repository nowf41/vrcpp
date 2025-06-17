export default function() {

    const path = require('node:path');
    const fs = require('node:fs');
    const {VRCLogDatabase} = require('./database.js');
    require('dotenv').config();

// load the latest log file
    const log_folder = process.env.VRCHAT_LOG_PATH || './';
    const logFilePath = path.join(
        log_folder,
        fs
            .readdirSync(log_folder)
            .filter(v => v.match(/^output_log_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.txt$/))
            .reduce((a, b) => a > b ? a : b)
    );
    let nowScanCursor = 0; // byte

    scan(logFilePath);
    fs.watchFile(logFilePath, (curr, prev) => {
        if (curr.size > prev.size) scan(logFilePath);
    })

    function scan(filePath: string) {
        console.log(`Scanning file: ${filePath}`);
        const end = fs.statSync(filePath).size - 1;
        const db = new VRCLogDatabase(process.env.DATABASE_PATH || './vrc_log.db');
        const rs = fs.createReadStream(filePath, {
            start: nowScanCursor + 1,
            end: end, // read until the end of the file
        }); // [start, end]

        let logs = '';

        rs.on('data', (chunk) => {
            logs += chunk.toString();
        })

        // when the stream ends, parse the logs (this prevents reading partial logs)
        rs.on('end', async () => {
            console.log(`Finished reading file: ${filePath}`);
            // parse
            const matches = Array.from(logs.matchAll(/[0-9]{4}.[0-9]{2}.[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[\S\s]+?(?=([0-9]{4}.[0-9]{2}.[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})|\n\n|>\n)/g));

            let currentSessionId: number = -1; // -1 is error value
            const exchangeIds: Map<string, number> = new Map();
            let localUser: string = '';
            // every log unit
            for await (const log of matches) {
                // get metadata
                const unixTime = new Date(log[0].match(/[0-9]{4}.[0-9]{2}.[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/)[0] || '1970-01-01 00:00:00').getTime() / 1000;
                const content = log[0]
                    .replace(/^[0-9]{4}.[0-9]{2}.[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/, '')
                    .replace(/ +Debug +- +/, '')
                    .trim();

                // handler
                if (content.startsWith('User Authenticated:')) {
                    const match = content.match(/(\S+) +?\((usr_\S+?)\)/)
                    if (match && match[1] && match[2]) {
                        localUser = match[2].trim();
                    }
                }

                if (content.startsWith('[Behaviour] Entering Room:')) {
                    const roomName = content.replace('[Behaviour] Entering Room: ', '').trim();
                    currentSessionId = await db.createSession(unixTime, roomName);
                }

                if (content.startsWith('[Behaviour] OnPlayerJoined')) {
                    const match = content.match(/(\S+) +?\((usr_\S+?)\)/)
                    if (match && match[1] && match[2]) {
                        const username = match[1].trim();
                        const vrchatInternalId = match[2].trim();

                        if (vrchatInternalId === localUser) continue;

                        const userId = (await db.existsUser(vrchatInternalId))
                            ? (await db.getUserId(vrchatInternalId))
                            : (await db.createUser(username, vrchatInternalId));

                        exchangeIds.set(vrchatInternalId, (await db.createExchange(currentSessionId, userId, unixTime)));
                    }
                }

                if (content.startsWith('[Behaviour] OnPlayerLeft')) {
                    const match = content.match(/(\S+) +?\((usr_\S+?)\)/)

                    if (match && match[1] && match[2]) {
                        const vrchatInternalId = match[2].trim();

                        if (vrchatInternalId === localUser) {
                            await db.endSession(currentSessionId, unixTime);
                            await db.run(`UPDATE exchanges
                                          SET end_time = ?
                                          WHERE end_time IS NULL;`);
                        } else {
                            await db.endExchange(exchangeIds.get(vrchatInternalId), unixTime);
                        }
                    }
                }
            }
            console.log(`Finished parsing file: ${filePath}`);
            nowScanCursor = end;
        })
    }
}