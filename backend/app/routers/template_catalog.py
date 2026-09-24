"""Public template catalogue; independent of LLM configuration."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..template_catalog import get_catalog, CatalogError

router = APIRouter(prefix="/api/template-catalog", tags=["templates"])

class TemplateRef(BaseModel):
    name: str
    version: str | None = None

class Selection(BaseModel):
    snapshotId: str
    selectedTemplates: list[TemplateRef] = Field(default_factory=list, max_length=100)
    preview: bool = False
    availability: bool = True

@router.get('/status')
async def status():
    return {"service": "template-catalog"}

@router.post('/revalidate')
async def revalidate():
    try: return await get_catalog().revalidate()
    except CatalogError as exc: raise HTTPException(503, str(exc)) from exc

@router.get('/snapshots/{snapshot_id}')
async def snapshot(snapshot_id: str):
    try: return (await get_catalog().get(snapshot_id)).public()
    except (CatalogError, ValueError) as exc: raise HTTPException(422, str(exc)) from exc

@router.post('/resolve')
async def resolve(selection: Selection):
    try:
        snapshot = await get_catalog().get(selection.snapshotId)
        return snapshot.resolve([ref.model_dump(exclude_none=True) for ref in selection.selectedTemplates],
                                preview=selection.preview, availability=selection.availability)
    except (CatalogError, ValueError) as exc: raise HTTPException(422, str(exc)) from exc

class TableValidation(Selection):
    tsv: str = Field(max_length=10_000_000)

@router.post('/validate-table')
async def validate_table(selection: TableValidation):
    from ..template_validation import validate_table as check
    try:
        snapshot = await get_catalog().get(selection.snapshotId)
        return check(snapshot, [ref.model_dump(exclude_none=True) for ref in selection.selectedTemplates], selection.tsv)
    except (CatalogError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
