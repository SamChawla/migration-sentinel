# UI Standards — Always Apply

## Frontend Stack
- **Tailwind CSS 4+** — utility-first CSS framework
- **daisyUI 5+** — component library (Tailwind plugin, zero JS, 35 free themes)
- **HTMX** — server-rendered interactivity without a JS framework
- **Alpine.js** — lightweight reactivity for dropdowns, modals, toggles

No React, Vue, or Angular. Django templates render HTML, HTMX makes it dynamic,
Alpine handles small client-side state. This is the modern Django stack.

## daisyUI Theming

### Platform Defaults
- Light mode: `nord` theme
- Dark mode: `dim` theme
- User toggle: light/dark switcher in navigation (stored in localStorage)

### Multi-Tenant Theming
Each community Admin can select their theme from all 35 built-in themes:
```python
# tenants/models.py
class Community(TenantMixin):
    name = models.CharField(max_length=100)
    slug = models.SlugField(unique=True)
    logo = models.ImageField(upload_to="community_logos/", blank=True)
    theme_light = models.CharField(max_length=30, default="nord")
    theme_dark = models.CharField(max_length=30, default="dim")
    # ...
```

Template applies the theme via `data-theme`:
```html
<!-- templates/base.html -->
<html data-theme="{{ request.tenant.theme_light }}"
      x-data="{ darkMode: localStorage.getItem('darkMode') === 'true' }"
      :data-theme="darkMode ? '{{ request.tenant.theme_dark }}' : '{{ request.tenant.theme_light }}'">
```

### Allowed Themes (all free, built into daisyUI)
Light: light, cupcake, bumblebee, emerald, corporate, retro, valentine,
garden, aqua, lofi, pastel, fantasy, wireframe, cmyk, autumn, acid,
lemonade, winter, nord

Dark: dark, synthwave, cyberpunk, halloween, forest, black, luxury,
dracula, business, night, coffee, dim, sunset, abyss

## Component Rules

### ALWAYS Use daisyUI Classes
```html
<!-- WRONG — raw Tailwind for common components -->
<button class="inline-flex items-center justify-center rounded-md bg-indigo-600
  px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700">
  Submit
</button>

<!-- CORRECT — daisyUI semantic class + Tailwind for spacing -->
<button class="btn btn-primary">Submit</button>
```

Use daisyUI classes for: `btn`, `card`, `modal`, `drawer`, `navbar`, `footer`,
`badge`, `alert`, `toast`, `tab`, `table`, `form-control`, `input`, `select`,
`textarea`, `checkbox`, `radio`, `toggle`, `dropdown`, `collapse`, `avatar`,
`breadcrumbs`, `pagination`, `loading`, `tooltip`, `swap`, `stat`, `hero`

Use raw Tailwind for: spacing (`p-4`, `mt-8`), layout (`flex`, `grid`),
sizing (`w-full`, `max-w-4xl`), custom one-off styling

### ALWAYS Use Semantic Color Names
```html
<!-- WRONG — hardcoded colors break theming -->
<div class="bg-blue-500 text-white">

<!-- CORRECT — semantic colors adapt to any theme -->
<div class="bg-primary text-primary-content">
```

daisyUI semantic colors:
- `primary`, `primary-content` — brand actions (buttons, links)
- `secondary`, `secondary-content` — supporting actions
- `accent`, `accent-content` — highlights, call-outs
- `neutral`, `neutral-content` — backgrounds, text
- `base-100`, `base-200`, `base-300` — page background layers
- `base-content` — default text color
- `info`, `success`, `warning`, `error` + `-content` — status colors

NEVER hardcode color values (`bg-blue-500`, `text-gray-800`, `#1D9E75`).
ALWAYS use semantic names so themes work correctly.

## Responsive Design

### Mobile-First Approach
All components start from mobile and scale up:
```html
<!-- Mobile: stack, Tablet: 2-col, Desktop: 3-col -->
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {% for event in events %}
    {% partial "event_card" %}
  {% endfor %}
</div>
```

### Breakpoints (Tailwind defaults)
- `sm:` — 640px+ (large phone landscape)
- `md:` — 768px+ (tablet)
- `lg:` — 1024px+ (desktop)
- `xl:` — 1280px+ (large desktop)

### Rules
- Every page must work on 320px-wide screens (small mobile)
- Navigation uses daisyUI `drawer` for mobile, `navbar` for desktop
- Tables use horizontal scroll on mobile: `<div class="overflow-x-auto">`
- Forms stack vertically on mobile, side-by-side on desktop
- Images use `loading="lazy"` and appropriate `srcset` for responsive sizes
- Test every page at 320px, 768px, and 1280px widths

## HTMX Patterns

### Server-Side Rendering with Dynamic Updates
```html
<!-- Load more events without full page reload -->
<div id="event-list">
  {% for event in events %}
    {% partial "event_card" %}
  {% endfor %}
</div>

<button class="btn btn-outline"
        hx-get="{% url 'events:list' %}?page={{ page_obj.next_page_number }}"
        hx-target="#event-list"
        hx-swap="beforeend"
        hx-indicator="#loading">
  Load More
</button>

<span id="loading" class="loading loading-spinner htmx-indicator"></span>
```

### HTMX Rules
- HTMX replaces full page reloads, NOT JavaScript frameworks
- Views return HTML fragments for HTMX requests, full pages for regular requests:
  ```python
  def event_list(request):
      events = Event.objects.all()
      template = "events/_event_list_partial.html" if request.htmx else "events/event_list.html"
      return render(request, template, {"events": events})
  ```
- Use `django-htmx` for the `request.htmx` attribute
- HTMX attributes go on the HTML element, NOT in JavaScript
- Use `hx-indicator` for loading states (daisyUI `loading` component)
- Use `hx-confirm` for destructive actions (delete event, remove member)
- CSRF: include `hx-headers='{"X-CSRFToken": "{{ csrf_token }}"}'` on body tag

### Alpine.js Rules
- Use Alpine for UI-only state: dropdowns, modals, toggles, tabs, dark mode switch
- NEVER use Alpine for data that should be server-side (form validation, permissions)
- Keep Alpine expressions short — complex logic goes in a named component:
  ```html
  <!-- Simple: inline -->
  <div x-data="{ open: false }">
    <button @click="open = !open" class="btn">Toggle</button>
    <div x-show="open" class="mt-2">Content</div>
  </div>

  <!-- Complex: named component in a <script> -->
  <div x-data="communityThemeSwitcher()">
  ```

## ORM Query Optimization for Templates

### Rules
- NEVER access related objects in templates without `select_related`/`prefetch_related` in the view:
  ```python
  # WRONG — causes N+1 queries when template does {{ event.organizer.username }}
  events = Event.objects.all()

  # CORRECT — single JOIN query
  events = Event.objects.select_related("organizer", "category").all()
  ```
- Use `{% with %}` to avoid repeated QuerySet evaluation in templates
- Paginate EVERY list view — never render unbounded QuerySets
- Use `only()` or `defer()` when templates need only a few fields from large models
- Use `django-debug-toolbar` during development to catch N+1 queries
- Cache expensive template fragments:
  ```html
  {% load cache %}
  {% cache 300 event_sidebar request.tenant.schema_name %}
    {# This block cached for 5 minutes per tenant #}
  {% endcache %}
  ```

## Template Structure

### Use Django 6 Template Partials
```html
<!-- templates/components/event_card.html -->
{% partialdef event_card %}
<div class="card bg-base-100 shadow-md">
  <figure>
    <img src="{{ event.cover_image.url }}" alt="{{ event.title }}" loading="lazy">
  </figure>
  <div class="card-body">
    <h2 class="card-title">{{ event.title }}</h2>
    <p>{{ event.description|truncatewords:20 }}</p>
    <div class="card-actions justify-end">
      <a href="{% url 'events:detail' event.slug %}" class="btn btn-primary btn-sm">View</a>
    </div>
  </div>
</div>
{% endpartialdef %}
```

### Template Hierarchy
```
templates/
├── base.html                    ← html, head, body, navbar, footer, theme
├── components/
│   ├── event_card.html          ← {% partialdef event_card %}
│   ├── job_card.html            ← {% partialdef job_card %}
│   ├── user_badge.html          ← {% partialdef user_badge %}
│   ├── theme_switcher.html      ← Alpine.js dark mode toggle
│   └── community_switcher.html  ← "My Communities" dropdown
├── events/
│   ├── event_list.html
│   ├── event_detail.html
│   ├── _event_list_partial.html ← HTMX partial for infinite scroll
│   └── event_form.html
├── jobs/
│   ├── job_list.html
│   ├── job_detail.html
│   └── job_form.html
└── accounts/
    ├── login.html
    ├── register.html
    └── profile.html
```

### Naming Conventions
- Full pages: `model_action.html` (e.g., `event_list.html`, `event_detail.html`)
- HTMX partials: `_model_partial.html` (prefix with underscore)
- Component partials: `components/name.html` using `{% partialdef %}`
- Base template: `base.html` with blocks: `title`, `content`, `extra_css`, `extra_js`

## Accessibility (a11y)

- Every `<img>` has an `alt` attribute
- Every form input has a `<label>` (daisyUI `form-control` pattern)
- Color is never the sole indicator of state (use icons + color)
- Focus states are visible (daisyUI handles this by default)
- Modals are keyboard-navigable (ESC to close, Tab to navigate)
- Semantic HTML: `<nav>`, `<main>`, `<article>`, `<section>`, `<aside>`, `<footer>`
