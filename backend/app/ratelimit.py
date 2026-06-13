"""Shared rate limiter (§3.4): 60 req/min per user by default; AI endpoints
declare 10/min at their own routes. Lives in its own module so both main.py and
the routers import the same Limiter without a circular import."""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
