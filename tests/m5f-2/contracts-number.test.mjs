import assert from "node:assert/strict";
import test from "node:test";
import { numberCalculationRequestContract, translationToolConfigurationContract } from "../../src/tools/contracts.mjs";
import { LocalNumberService } from "../../src/tools/local-number-service.mjs";

function configuration() {
  return {
    schemaVersion: "translation-tool-configuration-v1",
    dictionary: { providerId: "deepseek-flash", providerVersion: "v1", maxCalls: 8, maxCostMicrosUsd: 20_000,
      allowedDomains: ["dictionary.cambridge.org"] },
    entity: { providerId: "brave-web", providerVersion: "v1", maxCalls: 8, maxCostMicrosUsd: 40_000,
      allowedDomains: ["nasa.gov", "xbox.com"] },
    number: { providerId: "local-number", providerVersion: "local-number-v1", maxCalls: 32 },
  };
}

test("translation tool configuration freezes one provider per enabled tool", () => {
  const value = translationToolConfigurationContract(configuration());
  assert.equal(value.dictionary.providerId, "deepseek-flash");
  assert.equal(value.entity.providerId, "brave-web");
  assert.equal(value.number.providerId, "local-number");
  assert.throws(() => translationToolConfigurationContract({ ...configuration(), strategy: "balanced" }), TypeError);
  assert.throws(() => translationToolConfigurationContract({ ...configuration(), dictionary: [{ providerId: "a" }, { providerId: "b" }] }), TypeError);
  assert.throws(() => translationToolConfigurationContract({ ...configuration(), number: { ...configuration().number, providerId: "remote-number" } }), TypeError);
  assert.throws(() => translationToolConfigurationContract({ ...configuration(), entity: {
    ...configuration().entity, allowedDomains: ["xbox.com", "xbox.com"] } }), TypeError);
});

test("number request rejects expressions and accepts only typed operations", () => {
  const request = { schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "20.5",
    from: "lb", to: "kg", precision: 6, rounding: "half-even" };
  assert.deepEqual(numberCalculationRequestContract(request), request);
  assert.throws(() => numberCalculationRequestContract({ ...request, value: "2 + 2" }), TypeError);
  assert.throws(() => numberCalculationRequestContract({ ...request, expression: "2 + 2" }), TypeError);
  assert.throws(() => numberCalculationRequestContract({ ...request, operation: "exchange-rate" }), TypeError);
});

test("local number service performs exact scale conversions", () => {
  const service = new LocalNumberService();
  const result = service.calculate({ schemaVersion: "number-calculation-request-v1", operation: "scale", value: "20",
    from: "billion", to: "hundred-million", precision: 0, rounding: "half-even" });
  assert.equal(result.status, "resolved");
  assert.equal(result.formattedValue, "200");
  assert.equal(result.exactNumerator, "200");
  assert.equal(result.exactDenominator, "1");
  assert.equal(result.dimension, "number-scale");
  assert.match(result.receiptDigest, /^sha256:[0-9a-f]{64}$/);
});

test("local number service converts units with explicit deterministic rounding", () => {
  const service = new LocalNumberService();
  const mass = service.calculate({ schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "20",
    from: "lb", to: "kg", precision: 6, rounding: "half-even" });
  assert.equal(mass.status, "resolved");
  assert.equal(mass.formattedValue, "9.071847");
  assert.equal(mass.dimension, "mass");
  const temperature = service.calculate({ schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "32",
    from: "fahrenheit", to: "celsius", precision: 2, rounding: "half-up" });
  assert.equal(temperature.formattedValue, "0.00");
  assert.equal(temperature.dimension, "temperature");
});

test("local number service fails closed for invalid unknown and incompatible inputs", () => {
  const service = new LocalNumberService();
  const request = { schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "1",
    from: "m", to: "kg", precision: 2, rounding: "half-even" };
  assert.equal(service.calculate(request).status, "incompatible");
  assert.equal(service.calculate({ ...request, from: "parsec", to: "m" }).status, "unsupported");
  assert.throws(() => service.calculate({ ...request, value: "Infinity" }), TypeError);
  assert.throws(() => service.calculate({ ...request, value: "1e999" }), TypeError);
});

test("rounding handles negative ties and large exact integers without binary floats", () => {
  const service = new LocalNumberService();
  const tie = service.calculate({ schemaVersion: "number-calculation-request-v1", operation: "scale", value: "-2.5",
    from: "one", to: "one", precision: 0, rounding: "half-even" });
  assert.equal(tie.formattedValue, "-2");
  const large = service.calculate({ schemaVersion: "number-calculation-request-v1", operation: "scale",
    value: "900719925474099312345", from: "one", to: "one", precision: 0, rounding: "down" });
  assert.equal(large.formattedValue, "900719925474099312345");
});
