import asyncio
import sys
import json
import urllib.request
from datetime import datetime, timedelta

sys.path.insert(0, 'C:\\SuryaDTH')

RENDER_URL = 'https://surya-dth.onrender.com'
RECHARGE_AMOUNT = '177'
DAYS_BEFORE_EXPIRY = 10

PHOENIX_USERNAME = '11036318'
PHOENIX_PASSWORD = 'Tvsreddy@2021'
DISH_PASSWORD = 'Tvsreddy@2023'
D2H_PASSWORD = 'Tvsreddy@2023'

def parse_renewal_date(date_str):
    if not date_str:
        return None
    date_str = str(date_str).strip()
    formats = ['%d/%m/%y','%d-%m-%y','%d/%m/%Y','%d-%m-%Y','%Y-%m-%d']
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt)
        except:
            continue
    return None

def get_auto_renew_customers():
    try:
        all_customers = []
        next_token = None
        while True:
            url = f'{RENDER_URL}/autorenew?pageSize=300'
            if next_token:
                url += f'&nextPageToken={next_token}'
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=30) as response:
                data = json.loads(response.read().decode())
                customers = data.get('customers', [])
                all_customers.extend(customers)
                next_token = data.get('nextPageToken')
                if not next_token:
                    break
        return all_customers
    except Exception as e:
        print(f'[ERROR] Failed to get customers: {e}')
        return []

def update_last_recharged(vc, renewal_date_str):
    try:
        payload = json.dumps({
            'vc': vc,
            'lastRecharged': datetime.now().strftime('%Y-%m-%d'),
            'lastRenewalDate': renewal_date_str
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{RENDER_URL}/autorenew/updaterecharged',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            json.loads(response.read().decode())
            print(f'[UPDATE] lastRecharged saved for VC {vc}')
    except Exception as e:
        print(f'[ERROR] Failed to update lastRecharged: {e}')

def save_to_sheet(customer, order_id, status):
    try:
        name_safe = customer.get('name','').encode('ascii','ignore').decode('ascii')
        payload = json.dumps({
            'vc': customer.get('vc', ''),
            'name': name_safe,
            'mobile': customer.get('mobile', ''),
            'tech': 'AUTO RENEWAL',
            'company': customer.get('company', ''),
            'amount': RECHARGE_AMOUNT,
            'order_id': order_id,
            'status': status
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{RENDER_URL}/autorenew/saverecharge',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            json.loads(response.read().decode())
            print(f'[SHEET] Saved: {status}')
    except Exception as e:
        print(f'[ERROR] Failed to save to Sheet: {e}')

def trigger_recharge(vc, operator):
    try:
        payload = json.dumps({
            'vc': vc,
            'amount': RECHARGE_AMOUNT,
            'operator': operator,
            'order_id': f'AUTORENEW-{vc}-{datetime.now().strftime("%Y%m%d%H%M%S")}',
            'phoenix_username': PHOENIX_USERNAME,
            'phoenix_password': PHOENIX_PASSWORD,
            'dish_password': DISH_PASSWORD,
            'd2h_password': D2H_PASSWORD
        }).encode('utf-8')
        req = urllib.request.Request(
            'http://localhost:8001/recharge',
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=600) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f'[ERROR] Recharge failed for VC {vc}: {e}')
        return {'success': False, 'message': str(e)}

async def run_auto_renewal():
    print(f'\n[AUTO RENEWAL] Starting at {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')

    customers = get_auto_renew_customers()
    print(f'[AUTO RENEWAL] Total customers: {len(customers)}')

    if not customers:
        print('[AUTO RENEWAL] No customers. Exiting.')
        return

    today = datetime.now()
    to_recharge = []

    for c in customers:
        renewal_str = c.get('renewal', '')
        renewal_date = parse_renewal_date(renewal_str)
        last_recharged = c.get('lastRecharged', '')
        last_renewal_date = c.get('lastRenewalDate', '')
        name_safe = c.get('name','').encode('ascii','ignore').decode('ascii') or 'Customer'

        if not renewal_date:
            print(f'[SKIP] VC {c.get("vc")} - No renewal date')
            continue

        days_left = (renewal_date - today).days
        print(f'[CHECK] VC {c.get("vc")} | {name_safe} | Renewal: {renewal_str} | Days: {days_left}')

        if last_recharged and last_renewal_date == renewal_str:
            print(f'[SKIP] VC {c.get("vc")} - Already recharged on {last_recharged}')
            continue

        if 0 <= days_left <= DAYS_BEFORE_EXPIRY:
            to_recharge.append(c)
            print(f'[QUEUED] VC {c.get("vc")} - {days_left} days left')
        else:
            print(f'[SKIP] VC {c.get("vc")} - {days_left} days left - not yet')

    print(f'\n[AUTO RENEWAL] To recharge: {len(to_recharge)}')

    if not to_recharge:
        print('[AUTO RENEWAL] Nothing to recharge today.')
        return

    for i, customer in enumerate(to_recharge):
        vc = customer.get('vc', '')
        name_safe = customer.get('name','').encode('ascii','ignore').decode('ascii') or 'Customer'
        company = customer.get('company', '')
        renewal_str = customer.get('renewal', '')
        operator = 'D2H' if 'D2H' in company.upper() else 'DishTV'
        order_id = f'AUTORENEW-{vc}-{datetime.now().strftime("%Y%m%d%H%M%S")}'

        print(f'\n[RECHARGE {i+1}/{len(to_recharge)}] VC={vc} | {name_safe} | {operator}')

        result = trigger_recharge(vc, operator)

        # Unknown result వచ్చినప్పుడు 3 minutes wait చేసి retry చేయి
        if not result.get('success') and 'Unknown' in str(result.get('message', '')):
            print(f'[RETRY] VC {vc} - Unknown result, waiting 3 minutes...')
            await asyncio.sleep(180)
            result = trigger_recharge(vc, operator)

        if result.get('success'):
            print(f'[SUCCESS] VC {vc} recharged!')
            update_last_recharged(vc, renewal_str)
            save_to_sheet(customer, order_id, 'RECHARGED')
        elif 'Duplicate' in str(result.get('message', '')):
            # Duplicate వచ్చినప్పుడు → already recharged అయి ఉంటుంది → RECHARGED గా save చేయి
            print(f'[DUPLICATE] VC {vc} - Already recharged')
            update_last_recharged(vc, renewal_str)
            save_to_sheet(customer, order_id, 'RECHARGED')
        else:
            print(f'[FAILED] VC {vc} - {result.get("message")}')
            save_to_sheet(customer, order_id, f'PAID-RECHARGE FAILED: {result.get("message")}')

        if i < len(to_recharge) - 1:
            print(f'[WAIT] 3 minutes...')
            await asyncio.sleep(180)

    print(f'\n[AUTO RENEWAL] Done at {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')

def scheduler():
    import time
    print('[SCHEDULER] Auto Renewal Scheduler started')
    print('[SCHEDULER] Will run daily at 7:00 PM IST (1:30 PM UTC)')

    while True:
        now = datetime.now()
        target = now.replace(hour=13, minute=30, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)

        wait_seconds = (target - now).total_seconds()
        hours = int(wait_seconds // 3600)
        minutes = int((wait_seconds % 3600) // 60)
        print(f'[SCHEDULER] Next run in {hours}h {minutes}m (at 7:00 PM IST)')

        time.sleep(wait_seconds)
        asyncio.run(run_auto_renewal())

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--now':
        print('[TEST MODE] Running immediately...')
        asyncio.run(run_auto_renewal())
    else:
        scheduler()
