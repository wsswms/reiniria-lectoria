FROM python@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d

WORKDIR /experiment
COPY experiments/m5e-detector-tokenizers/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && python -m pip check
COPY experiments/m5e-detector-tokenizers/tokenizer_benchmark.py ./tokenizer_benchmark.py

ENTRYPOINT ["python", "/experiment/tokenizer_benchmark.py"]
