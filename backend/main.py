from fastapi import FastAPI

app = FastAPI(title='ParkBuddy Poland API')

@app.get('/api/health')
def health():
    return {'ok': True}
