from fastapi import APIRouter

from app.api.routes import (
    auth,
    availability,
    billing,
    channels,
    customers,
    dispatch,
    driver,
    drops,
    locations,
    operations,
    platform_admin,
    product_catalog,
    schedule,
    sms,
    tenant,
    uploads,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(locations.router)
api_router.include_router(billing.router)
api_router.include_router(channels.router)
api_router.include_router(product_catalog.router)
api_router.include_router(customers.router)
api_router.include_router(drops.router)
api_router.include_router(availability.router)
api_router.include_router(dispatch.router)
api_router.include_router(driver.router)
api_router.include_router(tenant.router)
api_router.include_router(uploads.router)
api_router.include_router(sms.router)
api_router.include_router(users.router)
api_router.include_router(operations.router)
api_router.include_router(operations.admin_router)

api_router.include_router(platform_admin.router)
api_router.include_router(schedule.router)  # add after the other include_router lines
