const test = require('tape');
const proxyquire = require('proxyquire').noCallThru();

test('tracer configures each enabled exporter once', (t) => {
  const exporters = [];
  let providerConfig;
  let registered = false;

  class Exporter {
    constructor(options) {
      this.options = options;
      exporters.push(this);
    }
  }

  const tracer = proxyquire('../tracer', {
    '@opentelemetry/api': {
      trace: {
        getTracer: (serviceName) => ({serviceName})
      }
    },
    '@opentelemetry/sdk-trace-node': {
      NodeTracerProvider: class {
        constructor(config) {
          providerConfig = config;
        }
        register() {
          registered = true;
        }
      }
    },
    '@opentelemetry/resources': {
      resourceFromAttributes: (attributes) => attributes
    },
    '@opentelemetry/semantic-conventions': {
      ATTR_SERVICE_NAME: 'service.name',
      ATTR_SERVICE_VERSION: 'service.version'
    },
    '@opentelemetry/sdk-trace-base': {
      BatchSpanProcessor: class {
        constructor(exporter, config) {
          this.exporter = exporter;
          this.config = config;
        }
      }
    },
    '@opentelemetry/exporter-jaeger': {JaegerExporter: Exporter},
    '@opentelemetry/exporter-zipkin': {ZipkinExporter: Exporter},
    '@opentelemetry/exporter-trace-otlp-http': {OTLPTraceExporter: Exporter},
    './lib/config': {
      JAMBONES_OTEL_ENABLED: true,
      OTEL_EXPORTER_JAEGER_ENDPOINT: 'http://jaeger',
      OTEL_EXPORTER_ZIPKIN_URL: 'http://zipkin',
      OTEL_EXPORTER_COLLECTOR_URL: 'http://collector'
    }
  });

  t.deepEqual(tracer('feature-server'), {serviceName: 'feature-server'});
  t.equal(exporters.length, 3, 'creates one exporter per configured backend');
  t.equal(providerConfig.spanProcessors.length, 3, 'configures one processor per exporter');
  t.deepEqual(providerConfig.resource, {
    'service.name': 'feature-server',
    'service.version': '0.9.8'
  });
  t.ok(registered, 'registers the tracer provider');
  t.end();
});
