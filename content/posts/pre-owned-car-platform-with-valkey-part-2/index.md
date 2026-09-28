+++
title = "🏎️ Building pre-owned Car Platform With Valkey - Part 2"
description = "How we moved the listing page of a used-car marketplace from Django filters on SQL to Valkey: each filter is a sorted set of car ids, a page is their intersection, and a personalised order is computed per request from one unordered set."
date = 2024-07-17T19:54:52+05:30
lastmod = 2024-07-17T19:54:52+05:30
publishDate = "2024-07-17T19:54:52+05:30"
draft = false
tags = ['django', 'redis', 'drf', 'cdc', 'valkey']
series = ['valkey-car-platform']
images = ["og-71f711d1.png"]
featured = false
hnItemId = 41282624
theme = "coral"
+++

About 40–60% of user interactions begin on the listing page: a grid of cars
with filters for city, price, make, and features. Each filter change used to
run a SQL query with several joins, a second query for the count, and a
serializer on top. This post shows how we moved that read path to Valkey. Each
filter becomes a sorted set of car ids, a page is the intersection of those
sets, one `HMGET` fetches the cards, and a personalised order is computed in
the web server from one unordered set. The list API got 4x faster, and a `wrk`
benchmark served 6x more requests.

We built this in 2021. [Part 1](/posts/building-blazingly-fast-pre-owned-car-platform-with-valkey-part-1)
covers the business, the user flow, and how we made the individual car page
fast.

# What the listing page needs

The listing page shows a list of cars with basic information, and it has to
load quickly because it is where most visits start. It needs three things:

- **Filters**: city, make, model, price range, colour, features, and so on.
- **Pagination**: a page of cars at a time, with the total count.
- **Order**: by price or date, or by a recommendation model that uses the
  buyer's browsing history.

# The existing way: Django filters on SQL

The schema, cut down to what the filters touch: a `car` has a price, a
colour, a locality (which belongs to a city), and a variant. A variant (for
example XM) belongs to a model (Nexon), and a model to a make (Tata). Features
such as AMT are many-to-many, through a `car_features` table.

The backend uses [Django](https://www.djangoproject.com/) and
[Django REST Framework](https://www.django-rest-framework.org/), with
[django-filter](https://django-filter.readthedocs.io/en/stable/guide/usage.html)
for the filters:

```py
from django_filters import rest_framework as filters

class NumberInFilter(filters.BaseInFilter, filters.NumberFilter):
    """Accepts a comma-separated list, e.g. make=10,12"""

class CarFilterSet(filters.FilterSet):
    """Custom filter class for filtering cars"""
    city_id = NumberInFilter(field_name="locality__city__id", lookup_expr="in")
    price_min = filters.NumberFilter(field_name="price", lookup_expr="gte")
    price_max = filters.NumberFilter(field_name="price", lookup_expr="lte")
    make = NumberInFilter(field_name="varient__model__make__id", lookup_expr="in")
    model = NumberInFilter(field_name="varient__model__id", lookup_expr="in")
    color = NumberInFilter(field_name="color__id", lookup_expr="in")
    features = NumberInFilter(field_name="features__id", lookup_expr="in")
    slug = SlugFilter()  # our own filter, described below

    class Meta:
        model = Car
        fields = [
            "make",
            "model",
            "year",
            "color",
            "price",
            "slug"
        ]
```

```py
from rest_framework import viewsets, mixins
from rest_framework.filters import OrderingFilter
from django_filters.rest_framework import DjangoFilterBackend
from .filters import CarFilterSet

class CarViewSet(viewsets.GenericViewSet, mixins.ListModelMixin):
    queryset = Car.objects.all() # django lazy queryset
    serializer_class = CarSerializer # converts django orm objects into json
    filter_backends = (DjangoFilterBackend, OrderingFilter) # django filters
    filterset_class = CarFilterSet # custom filterset
    ordering_fields = ["price", "year"]
    pagination_class = CarPagination
```

For each request, the ViewSet filters the queryset, cuts one page out of it,
and serializes that page to JSON.

## One request

```sql
GET https://api.car.com/listing/?city_id=1&price_min=200000&price_max=400000&make=120,121&ordering=price&page=2

SELECT car.id, car.price, car.varient_id, car.color_id, car.locality_id
  FROM car
 INNER JOIN locality ON (car.locality_id = locality.id)
 INNER JOIN varient ON (car.varient_id = varient.id)
 INNER JOIN model ON (varient.model_id = model.id)
 WHERE (locality.city_id IN (1) AND car.price >= 200000 AND car.price <= 400000
        AND model.make_id IN (120, 121))
 ORDER BY car.price ASC
 LIMIT 10   -- page_size
OFFSET 10   -- (page - 1) * page_size; max_page = ceil(count / page_size)
```

This is the SQL Django generates for the filter set above. It joins only the
tables a filter needs: `city_id` is already a column on `locality`, and
`make_id` a column on `model`, so `city` and `make` are never joined. Guess
the joins for one filter, then switch the others on:

{{< viz kind="sql-joins" fig="1" title="What each filter joins" fallback="sql-joins.svg" alt="The car schema as a graph of tables; switching filters on shows which tables Django joins and the SQL it generates" caption="SQL from Django 6.1 and django-filter 26.1 with this post's filter set (SQLite backend, quotes removed). `features` joins the through table, so a car with two of the requested features comes back twice until you add `.distinct()`." >}}

The response carries one page of cars and the total count:

```json
HTTP 200 OK
{
  "count": 1023,
  "next": "https://api.car.com/listing/?page=3",
  "previous": "https://api.car.com/listing/?page=1",
  "results": [
    {
      "id": 1,
      "images": [
        "https://cdn.car.com/1/front.webp",
        "https://cdn.car.com/1/left.webp",
        "https://cdn.car.com/1/right.webp",
        "https://cdn.car.com/1/back.webp"
      ],
      "price": 721000,
      "model_name": "Nexon",
      "varient_name": "XM",
      "link": "/user-cars/1",
      "city_name": "Mumbai",
      "owner": "1st"
    }
    . . . = page_size cars
  ]
}
```

## Slugs for search pages

For SEO, a listing page can also have a readable URL. When someone searches
Google for "used Nexon cars in Mumbai", the page they land on has that phrase
in its path:

```sql
🌐 https://car.com/used-nexon-cars-in-mumbai
-- client takes path and sends as slug query param to the backend
GET https://api.car.com/listing/?slug=used-nexon-cars-in-mumbai
```

The `SlugFilter` splits the slug into tokens and looks each one up in a table
to get the query string. Every slug maps to a valid combination of the
filters above.

```md
used-nexon-cars-in-mumbai => model=121&city=1
```

| id  | value  | type      | filter |
| --- | ------ | --------- | ------ |
| 1   | nexon  | model     | 121    |
| 2   | mumbai | city      | 1      |
| 3   | 4-lakh | price     | 400000 |
| 4   | tata   | make      | 2      |
| 5   | petrol | fuel_type | 1      |

## Why this falls short

Every request does the same work again. The filter query joins up to four
tables. Pagination runs a second query, `COUNT(*)` with the same joins. The
serializer then reads `model_name`, `varient_name` and `city_name`, which
costs more joins with `select_related`, or one query per car without it.
Many buyers ask for the same popular filter combinations, such as all cars in
Mumbai, and the database answers each one from scratch.

Two simpler fixes do not work well here:

- **Cache each response by URL.** Page number, ordering, and the order of the
  query parameters all make new keys for the same result. One sold car makes
  every cached page that contains it wrong, and there is no cheap way to find
  those pages.
- **Precompute every page, as Part 1 did for car pages.** A car page has one
  key per car. A listing page has one per combination of filters, and the
  number of combinations can be far larger than the number of cars.

What stays small is the set of cars that match each single filter value.

# Filters are sets

Each filter value picks a set of car ids: the cars in Mumbai, the cars priced
₹4–8 L, the cars with AMT. A page is the cars that are in every set the buyer
asked for, which is an intersection. A filter with several values, such as
`make=10,12`, is a union. Try it:

{{< viz kind="filter-sets" fig="2" title="Filters are sets" fallback="filter-sets.svg" alt="A listing request's four filters drawn as rows of car ids; the cars filled in every row are the page, served from Valkey while the SQL database stays off the read path" caption="Sample data: 12 cars. Each filter you switch on is one sorted set in Valkey, one row here. A car is on the page when its column is full in every row." >}}

Valkey[^1] keeps these sets in memory as sorted sets, one per filter
attribute, with the attribute as the score. A range filter is then a range
read:

```txt
ZRANGEBYSCORE car:price 100000 500000   # cars priced 1–5 L
ZRANGEBYSCORE car:color 5 5             # cars with color_id = 5
```

These reads are `O(log(N) + M)`, where `N` is the size of the set and `M` the
number of cars returned. Sorting a list or set with `SORT`[^2] instead costs
`O(N + M * log(M))`. Set operations[^4] (`ZINTERSTORE`, `ZUNIONSTORE`) combine
the results.

Features are many-to-many: one car has many features, and one feature belongs
to many cars. A single `car:feature` sorted set cannot hold that, so we keep
one set per feature, `car:feature:{id}`, with the car ids as members and a
score of 1.

# The keys

## `car:` holds the listing JSON

To serve the cards, we keep one hash, `car:`, with the car id as the field and
the listing JSON as the value. `HMGET car: 101 102 103` returns every card on
a page in one call; with a maximum page size of 35, that is at most 35 values.
(`MGET` over one string key per car would also be one call.)

A hash uses the compact listpack encoding only while it has at most 512
fields (`hash-max-listpack-entries`) and every value is at most 64 bytes
(`hash-max-listpack-value`)[^5]. Our `car:` hash holds every live car, and
each value is longer than 64 bytes, so Valkey stores it as a regular hash
table. In a test on Valkey 9.1 with 10,000 sample cars, the hash used about 5%
less memory than one string key per car. The large savings in
[Instagram's post](https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c)
come from many small hashes with short values; the setting it names,
`hash-zipmap-max-entries`, is now called `hash-max-listpack-entries`.

{{< viz kind="keys" key="hash" title="The car: hash" wide="false" fallback="keys.svg" alt="The car: hash maps car ids to listing JSON; HMGET returns one value per id and nil for a missing id" caption="Sample values. Encodings and replies from Valkey 9.1." >}}

## `car:<attribute>` holds the indexes

One sorted set per filter attribute. The members are car ids, and the score is
the attribute: `car:price` scores by price, `car:city` by city id, `car:make`
by make id. Each set holds every live car, so it has thousands of members.

{{< viz kind="keys" key="zset" title="The car:price index" wide="false" fallback="keys.svg" alt="The car:price sorted set maps car ids to prices; ZRANGEBYSCORE returns the cars in a price range" caption="Sample values. Encodings and replies from Valkey 9.1." >}}

## Keeping them fresh

We listen to the database change log. When a detail in the listing JSON
changes, we update that car's field in `car:`. When a car reaches a terminal
state, such as sold or removed, we delete its field from `car:` and its id
from every index set.

# Serving one page

Filtering a sorted set gives the cars in score order, so a price-ordered
result can be stored once and paged many times:

1. **Key.** Hash the filters into a key such as `page:price:{queryhash}`. The
   hash must not depend on parameter order, and it leaves out `page` and
   `ordering`: `F('city_id=1&color=3,4') eq F('color=4,3&city_id=1')`.
2. **Hit.** If the key exists, read one page with `ZRANGE key start stop`
   (`ZREVRANGE` for descending order), the total with `ZCARD`, and the cards
   with `HMGET car: …`.
3. **Miss.** Build the result from the indexes, store it with a TTL, and
   continue as for a hit:

   - `ZUNIONSTORE` for a filter with several values, such as `make=10,12`:

     ```txt
     ZUNIONSTORE all_cars 3 cars_set_1 cars_set_2 cars_set_3 AGGREGATE MAX
     ```

   - `ZINTERSTORE` to combine the filters:

     ```txt
     ZINTERSTORE filtered_cars 2 cars_set_1 cars_set_2 WEIGHTS 1 0
     ```

     By default, `ZINTERSTORE` adds up a car's scores from every input set.
     Give weight 1 only to the set whose score is the sort key, such as
     `car:price`, so the result keeps the price as its score.

The order depends only on car data, so a stored result is the same for every
buyer who sends that query, and later pages skip the filters entirely.

Some set operations we do in the web server instead, and fetch the cards with
`HMGET` afterwards:

```py
def filter_by_price(redis_pipe, price_min='-inf', price_max='+inf'):
    return redis_pipe.zrangebyscore(
        name="car:price",
        min=price_min,
        max=price_max
    )
```

A miss sends several commands, 12 in the example below. Valkey pipelining[^3] sends several
commands without waiting for each reply. It saves network round trips, and it
saves server work too: Valkey reads many commands with one `read()` system
call and writes many replies with one `write()`. The Valkey docs report up to
10 times more queries per second with long pipelines. We send the set
operations of a miss in one pipeline.

The figure follows one request over 12 sample cars: a miss, a hit for page 2,
and what a sale does to a stored result.

{{< viz kind="listing-request" fig="3" title="One listing request through Valkey" fallback="listing-request.svg" alt="A listing request is turned into a canonical key; on a miss, four index sets are intersected and stored with a TTL; page 2 is a hit; a sold car leaves a stale id in the stored result" caption="Sample data. The commands are one way to build the result on the server; every reply shown came from running them on Valkey 9.1 with this data. The key is `sha1` of the canonical query, first 18 hex digits. Use ← and → to step." >}}

# Personalised order

When the order comes from the recommendation model, it depends on the buyer,
and it changes every 45 minutes when we retrain the model. So we do not store
the order:

- **Key from car filters only.** We hash only the car-related filters. This
  pays off most on popular base pages, such as all cars in Mumbai.
- **Unordered set of car ids.** We store only the ids that match, with `SADD`.

On each request, the web server reads the set, ranks the ids with the LightFM
model it keeps in memory, slices out the requested page in Python, and fetches
those cards with `HMGET`.

A stored order would have to exist once per buyer, or buyer group, and be
rewritten after every retrain. The set is one key per query, and a retrain
writes nothing to Valkey. The cost moves to the web server, which scores every
id in the set on each request.

{{< viz kind="reco-order" fig="4" title="One set, ranked per buyer" fallback="reco-order.svg" alt="One unordered set of nine car ids in Valkey, ranked differently for two buyers and two model versions by LightFM in the web server" caption="Sample scores. The set in Valkey is the same for both buyers and both model versions; only the order in the web server changes. At one retrain every 45 minutes, a day has 32 retrains." >}}

# Where this hurts

- **Stale ids until the TTL ends.** A stored result is not an index, so the
  change-log consumer does not update it. A sold car stays in it, `HMGET`
  returns nil for that id, and the view must skip it. Until the key expires,
  the page is short and the count is too high (step 8 of Figure 3).
- **Empty results are never cached.** `ZINTERSTORE` does not store an empty
  set, so a filter that matches no car misses on every request.
- **Everything is in memory.** The `car:` hash, one sorted set per filter
  attribute, one set per feature, and every stored result.
- **Personalised pages cost CPU.** The web server scores every id in the set
  on every request, so a broad query with many cars costs more than a narrow
  one.

# Result

Production numbers from NewRelic, before and after the change.

{{< figure src="listing-viewset-list.png" title="List API: 4x faster" alt="NewRelic stats" width="auto" caption="Listing page 4x faster" >}}
{{< figure src="listing-viewset-retrieve.png" title="Retrieve API: 4.7x faster" alt="NewRelic stats" width="auto" caption="Dedicated page 4.7x faster" >}}
{{< figure src="overall-stats.png" title="Bottleneck moved from database to Python" alt="NewRelic stats" width="auto" caption="Bottleneck moved from database to python" >}}

A `wrk` benchmark of the list API:

{{< figure src="wrk-bench-diff.png" title="List API" alt="Wrk benchmark" width="auto" caption="We can serve 6x more requests" >}}

# What we showed

1. Django filters on SQL repeat the same joins and the same count for every
   buyer who asks for the same filters.
2. A filter value is a set of car ids, and a page is the intersection of those
   sets. Valkey sorted sets hold the sets, scored by the attribute.
3. One `car:` hash serves a whole page of cards with one `HMGET`.
4. A price-ordered result is stored once with a TTL and paged many times; a
   miss is one pipeline.
5. A personalised order is computed per request from one unordered set, so a
   model retrain writes nothing to Valkey.
6. The list API got 4x faster, and the bottleneck moved from the database to
   Python.

[^1]: {{< details "[Valkey](https://valkey.io/commands/) COMMAND Ref" >}}

| Command         | Description                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `SET`           | Sets the string value of a key, ignoring its type. The key is created if it doesn't exist.              |
| `TTL`           | Returns the expiration time in seconds of a key.                                                        |
| `HMSET`         | Sets the values of multiple fields.                                                                     |
| `HMGET`         | Returns the values of the given fields in a hash.                                                       |
| `HGETALL`       | Returns all fields and values in a hash.                                                                |
| `SADD`          | Adds one or more members to a set. Creates the key if it doesn't exist.                                 |
| `SCARD`         | Returns the number of members in a set.                                                                 |
| `SINTER`        | Returns the intersection of multiple sets.                                                              |
| `SINTERSTORE`   | Stores the intersection of multiple sets in a key.                                                      |
| `SISMEMBER`     | Determines whether a member belongs to a set.                                                           |
| `SUNION`        | Returns the union of multiple sets.                                                                     |
| `SUNIONSTORE`   | Stores the union of multiple sets in a key.                                                             |
| `ZADD`          | Adds one or more members to a sorted set, or updates their scores. Creates the key if it doesn't exist. |
| `ZCARD`         | Returns the number of members in a sorted set.                                                          |
| `ZCOUNT`        | Returns the count of members in a sorted set that have scores within a range.                           |
| `ZDIFFSTORE`    | Stores the difference of multiple sorted sets in a key.                                                 |
| `ZINTERSTORE`   | Stores the intersection of multiple sorted sets in a key.                                               |
| `ZMSCORE`       | Returns the score of one or more members in a sorted set.                                               |
| `ZRANGE`        | Returns members in a sorted set within a range of indexes.                                              |
| `ZRANGEBYSCORE` | Returns members in a sorted set within a range of scores.                                               |
| `ZRANGESTORE`   | Stores a range of members from a sorted set in a key.                                                   |
| `ZRANK`         | Returns the index of a member in a sorted set ordered by ascending scores.                              |
| `ZREM`          | Removes one or more members from a sorted set. Deletes the sorted set if all members were removed.      |
| `ZSCAN`         | Iterates over members and scores of a sorted set.                                                       |
| `ZSCORE`        | Returns the score of a member in a sorted set.                                                          |
| `ZUNION`        | Returns the union of multiple sorted sets.                                                              |
| `ZUNIONSTORE`   | Stores the union of multiple sorted sets in a key.                                                      |

{{</details>}}

[^2]: <https://valkey.io/commands/sort/>

[^3]: <https://valkey.io/topics/pipelining/>

[^4]: <https://en.wikipedia.org/wiki/Set_theory>

[^5]: <https://valkey.io/topics/memory-optimization/>
