import dgram from 'node:dgram';

// A minimal DNS server over UDP for the tests: answers A, AAAA, CNAME, MX, NS and TXT from a table,
// NXDOMAIN for the rest, and stays silent for the names listed in `silent`.

const TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };

const name = (n) => Buffer.concat([...n.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

function rdata(type, v) {
  if (type === 'A') return Buffer.from(v.split('.').map(Number));
  if (type === 'AAAA') {
    const parts = v.split('::');
    const head = parts[0] ? parts[0].split(':') : [], tail = parts[1] ? parts[1].split(':') : [];
    const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    return Buffer.concat(groups.map((g) => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(g, 16)); return b; }));
  }
  if (type === 'MX') { const p = Buffer.alloc(2); p.writeUInt16BE(v.priority); return Buffer.concat([p, name(v.exchange)]); }
  if (type === 'TXT') return Buffer.concat([...[].concat(v).map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]))]);
  return name(v); // NS, CNAME
}

export async function startDnsServer(table = {}, { silent = [] } = {}) {
  const server = dgram.createSocket('udp4');
  const queries = [];
  server.on('message', (msg, rinfo) => {
    const id = msg.readUInt16BE(0);
    let i = 12;
    const labels = [];
    while (msg[i]) { labels.push(msg.slice(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
    const qname = labels.join('.').toLowerCase();
    const qtype = msg.readUInt16BE(i + 1);
    const question = msg.slice(12, i + 5);
    const typeName = Object.keys(TYPES).find((k) => TYPES[k] === qtype);
    queries.push(`${qname} ${typeName}`);
    if (silent.includes(qname)) return;
    const records = (table[qname] && table[qname][typeName]) || [];
    const known = !!table[qname];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8180 | (known ? 0 : 3), 2); // response, recursion available; NXDOMAIN for unknown names
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    const answers = records.map((v) => {
      const data = rdata(typeName, v);
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0xc00c, 0);
      head.writeUInt16BE(qtype, 2);
      head.writeUInt16BE(1, 4);
      head.writeUInt32BE(60, 6);
      head.writeUInt16BE(data.length, 10);
      return Buffer.concat([head, data]);
    });
    server.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  return { port: server.address().port, address: `127.0.0.1:${server.address().port}`, queries, table, close: () => new Promise((r) => server.close(r)) };
}
