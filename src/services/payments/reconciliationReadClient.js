'use strict';
const Stripe = require('stripe');
const http = require('node:http');
const https = require('node:https');
const clients = new WeakMap();

// Stripe 17's Node transport can leave aborted JSON bodies unsettled, and its
// sender retries ECONNRESET/EPIPE once even with maxNetworkRetries=0. Isolate
// this correction to reconciliation GETs; never change the shared/write client.
class ReconciliationTransport extends Stripe.HttpClient {
    constructor(agent) { super(); this.agent = agent; }
    getClientName() { return 'uniclips-reconciliation-read'; }
    makeRequest(host, port, requestPath, method, headers, data, protocol, timeout) {
        if (method !== 'GET' || !/^\/v1\/transfers(?:\?|$)/.test(requestPath)) {
            return Promise.reject(new Error('Reconciliation transport is read-only'));
        }
        return new Promise((resolve, reject) => {
            let response, failure, complete = false, closed = false;
            const request = (protocol === 'http' ? http : https).request({
                host, port, path: requestPath, method, headers,
                ciphers: 'DEFAULT:!aNULL:!eNULL:!LOW:!EXPORT:!SSLv2:!MD5',
                ...(this.agent ? { agent: this.agent } : {}),
            });
            // Keep the original cause private and avoid the SDK's forced
            // reconnect-code retry. No retry or new financial instruction.
            const fail = () => {
                if (complete || failure) return;
                failure = Object.assign(new Error('Reconciliation transport unavailable'), {
                    code: 'P2I_RECONCILIATION_TRANSPORT',
                });
                request.destroy();
                response?.destroy();
                if (closed) reject(failure);
            };
            const timer = setTimeout(fail, timeout);
            request.on('error', fail);
            request.on('close', () => {
                closed = true;
                if (!complete) {
                    fail();
                    clearTimeout(timer);
                    reject(failure);
                }
            });
            request.on('response', incoming => {
                response = incoming;
                let body = '';
                incoming.setEncoding('utf8');
                incoming.on('data', chunk => { body += chunk; });
                incoming.on('error', fail);
                incoming.on('aborted', fail);
                incoming.on('end', () => {
                    if (failure) return;
                    complete = true;
                    clearTimeout(timer);
                    const result = new Stripe.HttpClientResponse(incoming.statusCode, incoming.headers);
                    result.getRawResponse = () => incoming;
                    result.toJSON = async () => JSON.parse(body);
                    resolve(result);
                });
            });
            request.end(data);
        });
    }
}

function reconciliationReadClient(original) {
    // Inert provider doubles retain their injected behavior.
    if (!(original instanceof Stripe)) return original;
    if (!clients.has(original)) {
        // The pinned SDK stores its authenticator as a function. Reuse that
        // function without extracting, duplicating or logging the API key.
        if (Stripe.PACKAGE_VERSION !== '17.7.0' || typeof original._authenticator !== 'function') throw new Error('Unsupported reconciliation client');
        const config = {
            authenticator: original._authenticator,
            host: original.getApiField('host'), port: original.getApiField('port'),
            protocol: original.getApiField('protocol'), apiVersion: original.getApiField('version'),
            stripeAccount: original.getApiField('stripeAccount'), stripeContext: original.getApiField('stripeContext'),
            timeout: 10000, maxNetworkRetries: 0,
            httpClient: new ReconciliationTransport(original.getApiField('agent')),
        };
        clients.set(original, new Stripe(null, config));
    }
    return clients.get(original);
}
module.exports = { reconciliationReadClient };
