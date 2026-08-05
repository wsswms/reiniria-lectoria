import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { calculationReceiptContract, numberCalculationRequestContract } from "./contracts.mjs";

const ALGORITHM_VERSION = "exact-rational-v1";
const REGISTRY_VERSION = "local-unit-registry-v1";

function abs(value) { return value < 0n ? -value : value; }
function gcd(left, right) {
  let a = abs(left); let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}
function rational(numerator, denominator = 1n) {
  if (denominator === 0n) throw new RangeError("zero denominator");
  let n = numerator; let d = denominator;
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return Object.freeze({ n: n / divisor, d: d / divisor });
}
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const divide = (a, b) => rational(a.n * b.d, a.d * b.n);

function parseDecimal(value) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return rational(numerator, denominator);
}

const R = (numerator, denominator = 1n) => rational(BigInt(numerator), BigInt(denominator));
const SCALE = Object.freeze({
  one: R(1), thousand: R(1_000), "ten-thousand": R(10_000), million: R(1_000_000),
  "ten-million": R(10_000_000), "hundred-million": R(100_000_000), billion: R(1_000_000_000), trillion: R(1_000_000_000_000),
});
const unit = (dimension, factorN, factorD = 1n, offsetN = 0n, offsetD = 1n) => Object.freeze({
  dimension, factor: R(factorN, factorD), offset: R(offsetN, offsetD),
});
const UNITS = Object.freeze({
  mm: unit("length", 1n, 1_000n), cm: unit("length", 1n, 100n), m: unit("length", 1n), km: unit("length", 1_000n),
  in: unit("length", 127n, 5_000n), ft: unit("length", 381n, 1_250n), yd: unit("length", 1_143n, 1_250n), mi: unit("length", 201_168n, 125n),
  mg: unit("mass", 1n, 1_000_000n), g: unit("mass", 1n, 1_000n), kg: unit("mass", 1n),
  oz: unit("mass", 45_359_237n, 1_600_000_000n), lb: unit("mass", 45_359_237n, 100_000_000n),
  "square-mm": unit("area", 1n, 1_000_000n), "square-cm": unit("area", 1n, 10_000n), "square-m": unit("area", 1n), "square-km": unit("area", 1_000_000n),
  ml: unit("volume", 1n, 1_000_000n), l: unit("volume", 1n, 1_000n), "cubic-m": unit("volume", 1n), "us-gallon": unit("volume", 473_176_473n, 125_000_000_000n),
  celsius: unit("temperature", 1n, 1n, 27_315n, 100n), kelvin: unit("temperature", 1n),
  fahrenheit: unit("temperature", 5n, 9n, 45_967n, 180n),
  "m-per-s": unit("speed", 1n), "km-per-h": unit("speed", 5n, 18n), mph: unit("speed", 1_397n, 3_125n),
  s: unit("time", 1n), min: unit("time", 60n), h: unit("time", 3_600n), day: unit("time", 86_400n),
  byte: unit("data", 1n), kb: unit("data", 1_000n), mb: unit("data", 1_000_000n), gb: unit("data", 1_000_000_000n),
  kib: unit("data", 1_024n), mib: unit("data", 1_048_576n), gib: unit("data", 1_073_741_824n),
});

function format(value, precision, rounding) {
  const factor = 10n ** BigInt(precision);
  const scaled = abs(value.n) * factor;
  let quotient = scaled / value.d;
  const remainder = scaled % value.d;
  const comparison = remainder * 2n - value.d;
  if (rounding === "half-up" && comparison >= 0n
    || rounding === "half-even" && (comparison > 0n || comparison === 0n && quotient % 2n === 1n)) quotient += 1n;
  let digits = quotient.toString();
  if (precision > 0) digits = digits.padStart(precision + 1, "0");
  const body = precision === 0 ? digits : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
  return value.n < 0n && quotient !== 0n ? `-${body}` : body;
}

function receipt(request, { status, dimension = null, value = R(0), formattedValue = "", formula = "" }) {
  const base = { schemaVersion: "calculation-receipt-v1", status, request, dimension,
    exactNumerator: value.n.toString(), exactDenominator: value.d.toString(), formattedValue, formula,
    algorithmVersion: ALGORITHM_VERSION, registryVersion: REGISTRY_VERSION };
  const receiptDigest = `sha256:${createHash("sha256").update(stableJson(base)).digest("hex")}`;
  return calculationReceiptContract({ ...base, receiptDigest });
}

export class LocalNumberService {
  calculate(input) {
    const request = numberCalculationRequestContract(input);
    const sourceValue = parseDecimal(request.value);
    if (request.operation === "scale") {
      const from = SCALE[request.from]; const to = SCALE[request.to];
      if (!from || !to) return receipt(request, { status: "unsupported" });
      const value = divide(multiply(sourceValue, from), to);
      return receipt(request, { status: "resolved", dimension: "number-scale", value,
        formattedValue: format(value, request.precision, request.rounding), formula: `${request.value} × ${request.from} ÷ ${request.to}` });
    }
    const from = UNITS[request.from]; const to = UNITS[request.to];
    if (!from || !to) return receipt(request, { status: "unsupported" });
    if (from.dimension !== to.dimension) return receipt(request, { status: "incompatible" });
    const base = add(multiply(sourceValue, from.factor), from.offset);
    const value = divide(subtract(base, to.offset), to.factor);
    return receipt(request, { status: "resolved", dimension: from.dimension, value,
      formattedValue: format(value, request.precision, request.rounding), formula: `(${request.value} × factor(${request.from}) + offset(${request.from}) - offset(${request.to})) ÷ factor(${request.to})` });
  }
}

export const LOCAL_NUMBER_PROVIDER_ID = "local-number";
export const LOCAL_NUMBER_PROVIDER_VERSION = "local-number-v1";
