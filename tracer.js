const opentelemetry = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
const  { OTLPTraceExporter } = require ('@opentelemetry/exporter-trace-otlp-http');
const {
  JAMBONES_OTEL_ENABLED,
  OTEL_EXPORTER_JAEGER_AGENT_HOST,
  OTEL_EXPORTER_JAEGER_ENDPOINT,
  OTEL_EXPORTER_ZIPKIN_URL,
  OTEL_EXPORTER_COLLECTOR_URL
} = require('./lib/config');

module.exports = (serviceName) => {
  if (JAMBONES_OTEL_ENABLED) {
    const {version} = require('./package.json');
    const exporters = [];

    if (OTEL_EXPORTER_JAEGER_AGENT_HOST  || OTEL_EXPORTER_JAEGER_ENDPOINT) {
      exporters.push(new JaegerExporter());
    }

    if (OTEL_EXPORTER_ZIPKIN_URL) {
      exporters.push(new ZipkinExporter({url:OTEL_EXPORTER_ZIPKIN_URL}));
    }

    if (OTEL_EXPORTER_COLLECTOR_URL) {
      exporters.push(new OTLPTraceExporter({
        url: OTEL_EXPORTER_COLLECTOR_URL
      }));
    }

    const spanProcessors = exporters.map((exporter) =>
      new BatchSpanProcessor(exporter, {
        // The maximum queue size. After the size is reached spans are dropped.
        maxQueueSize: 100,
        // The maximum batch size of every export. It must be smaller or equal to maxQueueSize.
        maxExportBatchSize: 10,
        // The interval between two consecutive exports
        scheduledDelayMillis: 500,
        // How long the export can run before it is cancelled
        exportTimeoutMillis: 30000,
      })
    );
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: version,
      }),
      spanProcessors,
    });

    // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
    provider.register();
  }

  return opentelemetry.trace.getTracer(serviceName);
};
