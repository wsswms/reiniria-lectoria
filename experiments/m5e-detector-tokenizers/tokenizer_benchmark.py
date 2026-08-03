import hashlib
import importlib.metadata
import json
import os
import platform
import re
import resource
import statistics
import sys
import time

import jieba
from sudachipy import dictionary, tokenizer

WARMUPS = 3
ITERATIONS = 30
WORDLIKE = re.compile(r"[^\W_]", re.UNICODE)


def private_input(path):
    stat = os.lstat(path)
    if not os.path.isfile(path) or os.path.islink(path) or stat.st_uid != os.getuid() or stat.st_mode & 0o077 or stat.st_size < 1 or stat.st_size > 16 * 1024 * 1024:
        raise RuntimeError("tokenizer corpus is invalid")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def private_output(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.chmod(path, 0o600)


def percentile(values, percentage):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int((len(ordered) - 1) * percentage)))]


def digest_tokens(tokens):
    encoded = json.dumps(tokens, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def wordlike(value):
    return bool(value and WORDLIKE.search(value))


class SudachiEngine:
    def __init__(self, split_mode):
        self.split_mode = split_mode
        self.instance = dictionary.Dictionary(dict="core").create()

    def segment(self, text):
        output = []
        for morpheme in self.instance.tokenize(text, self.split_mode):
            surface = morpheme.surface()
            if wordlike(surface):
                output.append({"value": surface, "start": morpheme.begin(), "end": morpheme.end()})
        return output


class JiebaEngine:
    def __init__(self, mode):
        self.mode = mode
        self.instance = jieba.Tokenizer()
        self.instance.initialize()

    def segment(self, text):
        output = []
        for value, start, end in self.instance.tokenize(text, mode=self.mode, HMM=True):
            if wordlike(value):
                output.append({"value": value, "start": start, "end": end})
        return output


def tokenize_document(document, language, engine):
    tokens = []
    for segment in document["segments"]:
        text = segment[language]
        for token_value in engine.segment(text):
            if text[token_value["start"]:token_value["end"]] != token_value["value"]:
                raise RuntimeError("tokenizer offset mismatch")
            tokens.append({"segmentId": segment["segmentId"], **token_value})
    return tokens


def benchmark(document, language, engine_name, engine):
    for _ in range(WARMUPS):
        tokenize_document(document, language, engine)
    durations = []
    digests = []
    tokens = None
    for index in range(ITERATIONS):
        started = time.perf_counter_ns()
        current = tokenize_document(document, language, engine)
        durations.append((time.perf_counter_ns() - started) / 1_000_000)
        if index < 5:
            digests.append(digest_tokens(current))
        if tokens is None:
            tokens = current
    return {
        "documentId": document["articleId"],
        "language": language,
        "engine": engine_name,
        "tokens": tokens,
        "tokenDigest": digest_tokens(tokens),
        "determinismDigests": digests,
        "timing": {
            "iterations": ITERATIONS,
            "minimumMs": min(durations),
            "p50Ms": statistics.median(durations),
            "p95Ms": percentile(durations, 0.95),
            "maximumMs": max(durations),
        },
    }


def main():
    if os.environ.get("M5E_TOKENIZER_SPIKE") != "execute":
        raise RuntimeError("tokenizer spike requires explicit execute gate")
    corpus = private_input(os.environ["M5E_TOKENIZER_CORPUS"])
    if corpus.get("schemaVersion") != "m5e-tokenizer-corpus-v1" or len(corpus.get("documents", [])) != 2:
        raise RuntimeError("tokenizer corpus schema mismatch")
    specifications = [
        ("sudachi-a", "ja", lambda: SudachiEngine(tokenizer.Tokenizer.SplitMode.A)),
        ("sudachi-b", "ja", lambda: SudachiEngine(tokenizer.Tokenizer.SplitMode.B)),
        ("sudachi-c", "ja", lambda: SudachiEngine(tokenizer.Tokenizer.SplitMode.C)),
        ("jieba-default", "zh", lambda: JiebaEngine("default")),
        ("jieba-search", "zh", lambda: JiebaEngine("search")),
    ]
    requested = {value for value in os.environ.get("M5E_TOKENIZER_ENGINES", "").split(",") if value}
    if requested and not requested.issubset({name for name, _, _ in specifications}):
        raise RuntimeError("unknown tokenizer engine")
    results = []
    for engine_name, language, factory in specifications:
        if requested and engine_name not in requested:
            continue
        engine = factory()
        for document in corpus["documents"]:
            results.append(benchmark(document, language, engine_name, engine))
    value = {
        "schemaVersion": "m5e-tokenizer-results-v1",
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "sudachipy": importlib.metadata.version("SudachiPy"),
            "sudachidictCore": importlib.metadata.version("sudachidict_core"),
            "jieba": importlib.metadata.version("jieba"),
            "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        },
        "warmups": WARMUPS,
        "iterations": ITERATIONS,
        "results": results,
    }
    private_output(os.environ["M5E_TOKENIZER_OUTPUT"], value)
    print(json.dumps({"status": "completed", "results": len(results), "peakRssBytes": value["runtime"]["peakRssBytes"]}))


if __name__ == "__main__":
    main()
