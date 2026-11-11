# -*- coding: utf-8 -*-
"""PostgreSQL + pgvector：每次需要時開一條連線（只有你一個人用，夠快）。"""
import contextlib
import os

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb  # noqa: F401  (給其他模組用)
from pgvector.psycopg import register_vector

from . import config

SCHEMA = os.path.join(config.HERE, "schema.sql")


def init():
    with psycopg.connect(config.DATABASE_URL, autocommit=True) as c:
        with open(SCHEMA, encoding="utf-8") as f:
            c.execute(f.read())


@contextlib.contextmanager
def connect():
    conn = psycopg.connect(config.DATABASE_URL, autocommit=True, row_factory=dict_row)
    try:
        register_vector(conn)
        yield conn
    finally:
        conn.close()


def one(sql, args=()):
    with connect() as c:
        return c.execute(sql, args).fetchone()


def all(sql, args=()):  # noqa: A001
    with connect() as c:
        return c.execute(sql, args).fetchall()


def run(sql, args=()):
    with connect() as c:
        c.execute(sql, args)


def get_setting(k, default=None):
    r = one("SELECT v FROM settings WHERE k = %s", (k,))
    return r["v"] if r else default


def set_setting(k, v):
    run("INSERT INTO settings (k, v) VALUES (%s, %s) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
        (k, Jsonb(v)))
