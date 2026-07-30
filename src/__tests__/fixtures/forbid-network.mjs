import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => {
  throw new Error('network forbidden');
};

globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
tls.connect = deny;
dgram.createSocket = deny;
dns.lookup = deny;
dns.resolve = deny;
syncBuiltinESMExports();
