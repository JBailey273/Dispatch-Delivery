from app.core.config import normalize_database_url


def test_normalize_database_url_rewrites_psycopg2_dialect() -> None:
    assert (
        normalize_database_url("postgresql+psycopg2://user:pass@localhost:5432/db")
        == "postgresql+psycopg://user:pass@localhost:5432/db"
    )


def test_normalize_database_url_rewrites_postgresql_scheme() -> None:
    assert (
        normalize_database_url("postgresql://user:pass@localhost:5432/db")
        == "postgresql+psycopg://user:pass@localhost:5432/db"
    )


def test_normalize_database_url_rewrites_postgres_scheme() -> None:
    assert (
        normalize_database_url("postgres://user:pass@localhost:5432/db")
        == "postgresql+psycopg://user:pass@localhost:5432/db"
    )


def test_normalize_database_url_leaves_non_postgres_urls_untouched() -> None:
    assert normalize_database_url("sqlite:///tmp/test.db") == "sqlite:///tmp/test.db"
